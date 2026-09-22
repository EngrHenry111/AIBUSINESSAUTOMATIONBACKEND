'use strict';

const fs = require('fs');
const Company = require('../models/Company');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const StoreCustomer = require('../models/StoreCustomer');
const { AppError } = require('../middleware/errorMiddleware');
const { paystackAPI } = require('../utils/paystack');
const { applyStockAdjustment } = require('./productController');
const { recordCustomerTransaction } = require('../utils/customerSync');
const emailService = require('../services/emailService');
const { sendOrderConfirmationSMS, sendStoreOrderSMS, sendSMS } = require('../services/smsService');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const LoyaltyProgram = require('../models/LoyaltyProgram');
const CustomerPoints = require('../models/CustomerPoints');
const { deductPointsFromCustomer } = require('../utils/loyaltyPoints');
const { awardLoyaltyForOrder } = require('./orderController');
const { resolveLineItem, computeDeliveryFee, applyCoupon } = require('../utils/storefrontCheckout');
const { cloudinary } = require('../config/cloudinary');

const clientUrl = () =>
  (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// ── Load an enabled store by slug ────────────────────────────────────
async function findStore(slug, { requirePayments = false } = {}) {
  const company = await Company.findOne({ storeSlug: String(slug || '').toLowerCase().trim() });
  if (!company || !company.storeEnabled) throw new AppError('Store not found.', 404);
  if (requirePayments && !company.paymentSettings?.isPaymentSetup) {
    throw new AppError('This store is not accepting payments yet.', 400);
  }
  return company;
}

// Explicit allowlist for anything shown to an anonymous shopper. `_id` here
// is the PRODUCT's id (required so the cart/checkout can say which item it
// means) — never the company's. costPrice, createdBy and companyId are
// deliberately never included.
const FLASH_SALE_LIVE = (p) => Boolean(p.isFlashSale && p.flashSalePrice != null && (!p.flashSaleEndsAt || new Date(p.flashSaleEndsAt) > new Date()));

const publicProduct = (p) => {
  const flashLive = FLASH_SALE_LIVE(p);
  return {
    _id: p._id,
    name: p.name,
    description: p.description,
    price: p.price,
    effectivePrice: flashLive ? p.flashSalePrice : p.price,
    currency: p.currency || 'NGN',
    images: p.images || [],
    category: p.category || null,
    sku: p.sku || null,
    unit: p.unit || null,
    tags: p.tags || [],
    variants: (p.variants || []).map((v) => ({
      name: v.name,
      options: (v.options || []).map((o) => ({ value: o.value, price: o.price ?? null, sku: o.sku, inStock: o.stock == null || o.stock > 0 })),
    })),
    ratings: { average: p.ratings?.average || 0, count: p.ratings?.count || 0 },
    isFlashSale: flashLive,
    flashSalePrice: flashLive ? p.flashSalePrice : null,
    flashSaleEndsAt: flashLive ? p.flashSaleEndsAt : null,
    isFeatured: Boolean(p.isFeatured),
    viewCount: p.viewCount || 0,
    sold: p.sold || 0,
    stock: {
      quantity: p.stock?.trackStock ? p.stock.quantity : null,
      trackStock: Boolean(p.stock?.trackStock),
      lowStockThreshold: p.stock?.lowStockThreshold ?? 5,
      allowOutOfStock: Boolean(p.stock?.allowOutOfStock),
    },
  };
};

// Product detail adds reviews + related products on top of the list shape.
const publicProductDetail = (p, related = []) => ({
  ...publicProduct(p),
  reviews: (p.reviews || []).slice().reverse().map((r) => ({
    customerName: r.customerName, rating: r.rating, comment: r.comment, createdAt: r.createdAt, verified: Boolean(r.verified),
  })),
  relatedProducts: related.map(publicProduct),
});

// Same idea for the company behind a store: an explicit allowlist so it's
// structurally impossible to leak _id, companyId or paymentSettings by
// spreading the raw Mongoose document into a response.
const publicStore = (company) => ({
  name: company.companyName,
  slug: company.storeSlug,
  logo: company.logo || null,
  currency: 'NGN',
  acceptsPayments: Boolean(company.paymentSettings?.isPaymentSetup),
  settings: {
    banner: company.storeSettings?.banner || null,
    description: company.storeSettings?.description || company.profile?.tagline || null,
    announcement: company.storeSettings?.announcement || null,
    primaryColor: company.storeSettings?.primaryColor || '#6366f1',
    showOutOfStock: company.storeSettings?.showOutOfStock !== false,
    allowBackorders: Boolean(company.storeSettings?.allowBackorders),
  },
  // Public contact details only — never bank details on the storefront.
  contact: {
    email: company.profile?.email || null,
    phone: company.profile?.phone || null,
    address: company.profile?.address || null,
    website: company.website || null,
    socials: company.profile?.socials || null,
  },
  // Delivery fees/POD availability are meant to be visible to shoppers before
  // they check out — never bank account details, which stay owner-only.
  deliverySettings: {
    feesByState: company.deliverySettings?.feesByState ? Object.fromEntries(company.deliverySettings.feesByState) : {},
    defaultFee: company.deliverySettings?.defaultFee ?? 2000,
    freeDeliveryMinimum: company.deliverySettings?.freeDeliveryMinimum ?? null,
    estimatedDeliveryDays: company.deliverySettings?.estimatedDeliveryDays ?? 3,
    podEnabled: Boolean(company.deliverySettings?.podEnabled),
    podMaxAmount: company.deliverySettings?.podMaxAmount ?? 50000,
  },
});

// Which products are visible in a given store
function storeProductQuery(company, { category, search, minPrice, maxPrice, minRating, inStockOnly, featured, flashSale } = {}) {
  const q = { companyId: company._id, status: { $ne: 'inactive' } };
  if (!company.storeSettings?.showOutOfStock && !inStockOnly) {
    q.$or = [
      { 'stock.trackStock': false },
      { 'stock.quantity': { $gt: 0 } },
      { 'stock.allowOutOfStock': true },
    ];
  } else if (inStockOnly) {
    q.$or = [
      { 'stock.trackStock': false },
      { 'stock.quantity': { $gt: 0 } },
    ];
  }
  if (category) q.category = category;
  if (search && search.trim()) {
    const rx = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    q.$and = [{ $or: [{ name: rx }, { description: rx }, { category: rx }, { tags: rx }] }];
  }
  if (minPrice != null || maxPrice != null) {
    q.price = {};
    if (minPrice != null) q.price.$gte = Number(minPrice);
    if (maxPrice != null) q.price.$lte = Number(maxPrice);
  }
  if (minRating != null) q['ratings.average'] = { $gte: Number(minRating) };
  if (featured === 'true' || featured === true) q.isFeatured = true;
  if (flashSale === 'true' || flashSale === true) {
    q.isFlashSale = true;
    q.$and = [...(q.$and || []), { $or: [{ flashSaleEndsAt: null }, { flashSaleEndsAt: { $gt: new Date() } }] }];
  }
  return q;
}

const SORTS = {
  newest: { createdAt: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  rating: { 'ratings.average': -1 },
  popular: { sold: -1 },
};

// ── GET /store/:slug ─────────────────────────────────────────────────
exports.getStore = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const [products, categories] = await Promise.all([
      Product.find(storeProductQuery(company)).sort({ createdAt: -1 }).limit(200).lean(),
      Product.distinct('category', { companyId: company._id, status: { $ne: 'inactive' }, category: { $nin: [null, ''] } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        store: publicStore(company),
        products: products.map(publicProduct),
        categories: categories.sort(),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/products ───────────────────────────────────────
exports.getStoreProducts = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const query = storeProductQuery(company, req.query);
    const sort = SORTS[req.query.sort] || SORTS.newest;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(60, Number(req.query.limit) || 24);

    const [products, total] = await Promise.all([
      Product.find(query).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: products.map(publicProduct),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/products/:id ───────────────────────────────────
exports.getStoreProduct = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const product = await Product.findOne({ _id: req.params.id, companyId: company._id, status: { $ne: 'inactive' } });
    if (!product) return next(new AppError('Product not found.', 404));

    Product.updateOne({ _id: product._id }, { $inc: { viewCount: 1 } }).catch(() => {});

    const relatedIds = product.relatedProducts?.length
      ? product.relatedProducts
      : (await Product.find({ companyId: company._id, category: product.category, _id: { $ne: product._id }, status: { $ne: 'inactive' } }).select('_id').limit(4).lean()).map((p) => p._id);
    const related = relatedIds.length
      ? await Product.find({ _id: { $in: relatedIds }, companyId: company._id, status: { $ne: 'inactive' } }).limit(4).lean()
      : [];

    res.status(200).json({ success: true, data: publicProductDetail(product, related) });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/categories ────────────────────────────────────
exports.getStoreCategories = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const categories = await Product.distinct('category', {
      companyId: company._id, status: { $ne: 'inactive' }, category: { $nin: [null, ''] },
    });
    res.status(200).json({ success: true, data: categories.sort() });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/loyalty?email= ─────────────────────────────────
// Public — lets the checkout page show "You have N points" before the
// customer pays. No auth; only ever returns this one shopper's own balance.
exports.getStoreLoyaltyStatus = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const email = String(req.query.email || '').trim().toLowerCase();
    const program = await LoyaltyProgram.findOne({ companyId: company._id });

    if (!program?.enabled || !email) {
      return res.status(200).json({ success: true, data: { enabled: false, points: 0 } });
    }

    const record = await CustomerPoints.findOne({ companyId: company._id, customerEmail: email });
    const points = record?.currentPoints || 0;
    res.status(200).json({
      success: true,
      data: {
        enabled: true,
        points,
        nairaPerPoint: program.nairaPerPoint,
        minimumRedemption: program.minimumRedemption,
        redeemableValue: points >= program.minimumRedemption ? Math.round(points * program.nairaPerPoint * 100) / 100 : 0,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/products/:id/review ───────────────────────────
// Only a customer who actually bought this product (a delivered order
// containing it, matched by email) can review it — the whole point of a
// "verified" badge is that it isn't self-reported.
exports.addProductReview = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const { customerName, customerEmail, rating, comment } = req.body;
    const email = String(customerEmail || '').trim().toLowerCase();
    const numRating = Number(rating);

    if (!email || !numRating || numRating < 1 || numRating > 5) {
      return next(new AppError('A valid email and a rating from 1-5 are required.', 400));
    }

    const product = await Product.findOne({ _id: req.params.id, companyId: company._id });
    if (!product) return next(new AppError('Product not found.', 404));

    const purchased = await Order.exists({
      companyId: company._id,
      'customer.email': email,
      'items.productId': product._id,
      status: { $in: ['delivered', 'confirmed', 'processing', 'shipped'] },
    });
    if (!purchased) {
      return next(new AppError('Only customers who have ordered this product can review it.', 403));
    }
    if (product.reviews.some((r) => r.customerEmail === email)) {
      return next(new AppError('You have already reviewed this product.', 409));
    }

    product.reviews.push({ customerName: customerName || 'Anonymous', customerEmail: email, rating: numRating, comment, verified: true, createdAt: new Date() });
    const total = product.reviews.reduce((s, r) => s + r.rating, 0);
    product.ratings = { average: Math.round((total / product.reviews.length) * 10) / 10, count: product.reviews.length };
    await product.save();

    res.status(201).json({ success: true, data: { ratings: product.ratings } });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/coupon/validate ────────────────────────────────
exports.validateCoupon = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const { code, orderTotal } = req.body;
    if (!code) return next(new AppError('Enter a coupon code.', 400));

    const coupon = await Coupon.findOne({ companyId: company._id, code: String(code).trim().toUpperCase() });
    if (!coupon) return next(new AppError('This coupon code is not valid.', 400));

    const discount = applyCoupon(coupon, Number(orderTotal) || 0, []);
    res.status(200).json({ success: true, data: { code: coupon.code, type: coupon.type, value: coupon.value, discount } });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/track/:orderNumber?email= ──────────────────────
// Public order lookup — both the order number AND the matching email are
// required, so a guessed order number alone can't expose someone else's
// order details.
exports.trackOrder = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return next(new AppError('Enter the email address used for this order.', 400));

    const order = await Order.findOne({
      companyId: company._id, orderNumber: req.params.orderNumber, 'customer.email': email,
    }).lean();
    if (!order) return next(new AppError('No matching order found. Check your order number and email.', 404));

    res.status(200).json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        total: order.total,
        currency: order.currency || 'NGN',
        trackingNumber: order.trackingNumber || null,
        carrier: order.carrier || null,
        estimatedDelivery: order.estimatedDelivery || null,
        deliveredAt: order.deliveredAt || null,
        items: (order.items || []).map((i) => ({ name: i.name, variant: i.variant, quantity: i.quantity, image: i.image })),
        timeline: (order.timeline || []).map((t) => ({ status: t.status, description: t.description, timestamp: t.timestamp })),
        createdAt: order.createdAt,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/orders/:id/bank-proof ──────────────────────────
// Public — the customer uploads their transfer screenshot right after
// placing a bank_transfer order. Requires the matching email as a
// lightweight ownership check, same reasoning as trackOrder above.
exports.uploadBankProof = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!req.file) return next(new AppError('No image received.', 400));
    if (!email) { fs.unlink(req.file.path, () => {}); return next(new AppError('Enter the email used for this order.', 400)); }

    // Identified by orderNumber (not _id) — the storefront never learns an
    // order's internal Mongo id, same as trackOrder().
    const order = await Order.findOne({ orderNumber: req.params.orderNumber, companyId: company._id, 'customer.email': email });
    if (!order) { fs.unlink(req.file.path, () => {}); return next(new AppError('Order not found.', 404)); }

    let url;
    if (cloudinary) {
      const r = await cloudinary.uploader.upload(req.file.path, { folder: `business-ai/${company._id}/payment-proofs`, resource_type: 'image' });
      fs.unlink(req.file.path, () => {});
      url = r.secure_url;
    } else {
      url = `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${req.file.path.split(/[\\/]/).pop()}`;
    }

    order.bankTransferProof = url;
    order.timeline.push({ status: order.status, description: 'Customer uploaded bank transfer proof', timestamp: new Date() });
    await order.save();

    const owner = await User.findById(company.owner).select('name email');
    if (owner?.email) {
      emailService.send({
        to: owner.email,
        subject: `Payment proof uploaded — order ${order.orderNumber}`,
        html: emailService.baseTemplate('Payment Proof Uploaded', `
          <h2 style="color:#0f172a;margin:0 0 6px;">Bank transfer proof received</h2>
          <p style="color:#475569;font-size:14px;margin:0 0 16px;">${order.customer?.name || 'A customer'} uploaded a payment screenshot for order <strong>${order.orderNumber}</strong> (${naira(order.total)}).</p>
          <p><a href="${url}" style="color:#6366f1;">View the uploaded proof</a></p>
          <p style="margin:20px 0 0;"><a href="${clientUrl()}/orders" style="background:#6366f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">Review in BizlyAI</a></p>
        `),
      }).catch(() => {});
    }

    res.status(200).json({ success: true, data: { bankTransferProof: url } });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/checkout ─────────────────────────────────────
const PAYMENT_METHODS = ['paystack', 'pay_on_delivery', 'bank_transfer', 'split_payment'];

exports.initializeStorePayment = async (req, res, next) => {
  try {
    const {
      items = [], customer = {}, redeemPoints = 0, couponCode,
      paymentMethod = 'paystack', shippingState, shippingCity, notes,
    } = req.body;
    if (!PAYMENT_METHODS.includes(paymentMethod)) return next(new AppError('Invalid payment method.', 400));

    // Bank transfer and pay-on-delivery don't touch Paystack at checkout time,
    // so they don't need a subaccount configured — only the two card/transfer
    // paths that actually charge through Paystack do.
    const needsPaystack = paymentMethod === 'paystack' || paymentMethod === 'split_payment';
    const company = await findStore(req.params.slug, { requirePayments: needsPaystack });

    if (!Array.isArray(items) || items.length === 0) return next(new AppError('Your cart is empty.', 400));
    if (!customer.name || !customer.email || !customer.phone) {
      return next(new AppError('Name, email and phone are required.', 400));
    }
    if (!/^\S+@\S+\.\S+$/.test(customer.email)) return next(new AppError('Enter a valid email address.', 400));

    const ids = [...new Set(items.map((i) => String(i.productId)))];
    const products = await Product.find({ _id: { $in: ids }, companyId: company._id, status: { $ne: 'inactive' } });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    let subtotal = 0;
    const resolvedItems = [];
    for (const it of items) {
      const p = byId.get(String(it.productId));
      if (!p) return next(new AppError('One of the products is no longer available.', 400));
      const line = resolveLineItem(p, it); // throws AppError on a stock/variant problem
      subtotal += line.total;
      resolvedItems.push(line);
    }
    if (subtotal <= 0) return next(new AppError('Order total must be greater than zero.', 400));

    const deliveryFee = computeDeliveryFee(company, subtotal, shippingState);

    let discount = 0;
    let appliedCouponCode = null;
    if (couponCode) {
      const coupon = await Coupon.findOne({ companyId: company._id, code: String(couponCode).trim().toUpperCase() });
      if (!coupon) return next(new AppError('This coupon code is not valid.', 400));
      discount = applyCoupon(coupon, subtotal, resolvedItems.map((i) => i.productId));
      appliedCouponCode = coupon.code;
    }

    let total = Math.round((subtotal + deliveryFee - discount) * 100) / 100;

    // Loyalty redemption — re-validate server-side against the customer's
    // real balance rather than trusting the discount the client computed.
    let loyaltyRedeemed = null;
    const requestedPoints = Math.max(0, parseInt(redeemPoints, 10) || 0);
    if (requestedPoints > 0) {
      const program = await LoyaltyProgram.findOne({ companyId: company._id });
      const email = String(customer.email).trim().toLowerCase();
      const record = program?.enabled ? await CustomerPoints.findOne({ companyId: company._id, customerEmail: email }) : null;

      if (program?.enabled && record && requestedPoints >= program.minimumRedemption && record.currentPoints >= requestedPoints) {
        const loyaltyDiscount = Math.min(total - 1, Math.round(requestedPoints * program.nairaPerPoint * 100) / 100);
        if (loyaltyDiscount > 0) {
          total -= loyaltyDiscount;
          loyaltyRedeemed = { points: requestedPoints, discount: loyaltyDiscount };
        }
      }
    }

    const customerPayload = {
      name: String(customer.name).slice(0, 120),
      email: customer.email,
      phone: String(customer.phone).slice(0, 40),
      address: customer.address ? String(customer.address).slice(0, 300) : undefined,
      city: shippingCity ? String(shippingCity).slice(0, 80) : undefined,
      state: shippingState ? String(shippingState).slice(0, 80) : undefined,
    };
    const orderMeta = {
      items: resolvedItems, subtotal, deliveryFee, discount, couponCode: appliedCouponCode,
      loyaltyRedeemed, customer: customerPayload, notes: notes ? String(notes).slice(0, 500) : undefined,
    };

    // ── Pay on Delivery — order placed now, paid in cash on arrival ──────
    if (paymentMethod === 'pay_on_delivery') {
      const ds = company.deliverySettings || {};
      if (!ds.podEnabled) return next(new AppError('Pay on delivery is not available for this store.', 400));
      if (total > (ds.podMaxAmount ?? 50000)) {
        return next(new AppError(`Pay on delivery is only available for orders up to ${naira(ds.podMaxAmount ?? 50000)}.`, 400));
      }
      const order = await createDirectOrder(company, { ...orderMeta, total, paymentMethod: 'pay_on_delivery' }, { io: req.app.get('io') });
      return res.status(201).json({ success: true, data: { order: publicOrder(order), total, directOrder: true } });
    }

    // ── Bank Transfer — order placed now, awaiting the owner's manual approval ──
    if (paymentMethod === 'bank_transfer') {
      const order = await createDirectOrder(company, { ...orderMeta, total, paymentMethod: 'bank_transfer' }, { io: req.app.get('io') });
      return res.status(201).json({
        success: true,
        data: {
          order: publicOrder(order), total, directOrder: true,
          bankDetails: {
            bankName: company.paymentSettings?.bankName || null,
            accountName: company.paymentSettings?.accountName || null,
            accountNumber: company.paymentSettings?.accountNumber || null,
          },
        },
      });
    }

    // ── Paystack (full amount) or Split (50% now, 50% on delivery) ─────
    const chargeAmount = paymentMethod === 'split_payment' ? Math.round((total / 2) * 100) / 100 : total;

    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email: customer.email,
      amount: Math.round(chargeAmount * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: {
        type: 'storefront_order',
        companyId: String(company._id),
        slug: company.storeSlug,
        paymentMethod,
        orderTotal: total,
        ...orderMeta,
      },
      callback_url: `${clientUrl()}/store/${company.storeSlug}/success`,
    });

    if (!initRes.status) throw new AppError('Could not start checkout. Please try again.', 502);

    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: initRes.data.authorization_url,
        accessCode: initRes.data.access_code,
        reference: initRes.data.reference,
        total, chargeAmount, deliveryFee, discount, loyaltyRedeemed,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/verify/:reference ────────────────────────────
exports.verifyStorePayment = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const { reference } = req.params;

    const existing = await Order.findOne({ paystackReference: reference, companyId: company._id }).lean();
    if (existing) {
      return res.status(200).json({ success: true, data: { order: publicOrder(existing) } });
    }

    const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!vr.status || vr.data?.status !== 'success') {
      return next(new AppError('Payment has not been completed.', 400));
    }
    if (String(vr.data.metadata?.companyId) !== String(company._id)
      || vr.data.metadata?.type !== 'storefront_order') {
      return next(new AppError('This payment does not belong to this store.', 400));
    }

    // The webhook is the primary path — this is the backup for when it's
    // missed entirely (misconfigured webhook URL, Paystack retry exhausted,
    // etc.). fulfilStorefrontOrder() itself re-checks for an existing order
    // by reference, so calling it here is safe even if the webhook actually
    // did fire a moment earlier — no duplicate order is created either way.
    console.log(`Creating order from verify (webhook missed) — reference ${reference}`);
    const order = await fulfilStorefrontOrder(company, vr.data, { io: req.app.get('io') });
    res.status(200).json({ success: true, data: { order: publicOrder(order) } });
  } catch (err) { next(err); }
};

const publicOrder = (o) => ({
  orderNumber: o.orderNumber,
  status: o.status,
  paymentStatus: o.paymentStatus,
  paymentMethod: o.paymentMethod,
  subtotal: o.subtotal,
  deliveryFee: o.deliveryFee,
  discount: o.discount,
  loyaltyDiscount: o.loyaltyDiscount,
  total: o.total,
  currency: o.currency || 'NGN',
  customer: { name: o.customer?.name, email: o.customer?.email },
  items: (o.items || []).map((i) => ({ name: i.name, image: i.image, variant: i.variant, quantity: i.quantity, price: i.price })),
  createdAt: o.createdAt,
});

async function nextOrderNumber(companyId) {
  const count = await Order.countDocuments({ companyId });
  return `ORD-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
}

// ── Shared post-creation work for every storefront order, regardless of
// payment method: stock deduction, customer record sync, coupon usage,
// loyalty spend/earn, cache/socket invalidation, emails and SMS. Called
// once the Order document already exists (and only once — callers are
// responsible for their own idempotency, e.g. the paystackReference unique
// index for the Paystack path). ─────────────────────────────────────────
async function finalizePlacedOrder(company, order, { io } = {}) {
  const ids = [...new Set((order.items || []).map((i) => String(i.productId)).filter(Boolean))];
  const products = await Product.find({ _id: { $in: ids }, companyId: company._id });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  let anyLow = false;
  for (const item of order.items) {
    if (!item.productId || !item.quantity) continue;
    const product = byId.get(String(item.productId));
    if (!product || !product.stock?.trackStock) continue;
    try {
      const { low, newQuantity } = await applyStockAdjustment(product, -Math.abs(item.quantity), {
        reason: 'sale', orderId: order._id, note: `Store order ${order.orderNumber}`,
      });
      if (newQuantity < 0) {
        // Should be structurally impossible — applyStockAdjustment() already
        // clamps at 0 — but this order's whole point is customer trust, so
        // it self-heals instead of silently carrying a negative count.
        product.stock.quantity = 0;
        await product.save();
        logger.warn(`Negative stock corrected for ${product.name} after order ${order.orderNumber}`);
      }
      if (low) anyLow = true;
    } catch (e) { logger.warn(`Store stock adjust failed: ${e.message}`); }
    // sold count — informational, drives the "popular" sort
    Product.updateOne({ _id: product._id }, { $inc: { sold: item.quantity } }).catch(() => {});
  }
  order.stockApplied = true;
  await order.save();

  await recordCustomerTransaction({
    companyId: company._id, customer: order.customer, amount: order.total, countsAsOrder: true, date: order.createdAt,
  });

  // Roll up onto the shopper's store account, if they have one — matched by
  // email since a guest checkout never carries a StoreCustomer id.
  if (order.customer?.email) {
    StoreCustomer.updateOne(
      { companyId: company._id, email: order.customer.email },
      { $inc: { orderCount: 1, totalSpent: order.total } },
    ).catch(() => {});
  }

  if (order.couponCode) {
    Coupon.updateOne({ companyId: company._id, code: order.couponCode }, { $inc: { usedCount: 1 } }).catch(() => {});
  }

  // Loyalty points spent at checkout — only deducted now that the order is
  // actually placed, never at initialization time.
  if (order.loyaltyPointsUsed > 0) {
    await deductPointsFromCustomer(company._id, order.customer, order.loyaltyPointsUsed, {
      description: `Redeemed at checkout — order ${order.orderNumber}`, orderId: order._id,
    });
  }

  // Loyalty points earned — only for orders paid in full right now. Pay on
  // delivery / bank transfer / the unpaid half of a split payment haven't
  // actually been paid yet, so earning is deferred to whenever the order
  // later transitions to 'delivered' (see orderController.awardLoyaltyForOrder).
  if (order.paymentStatus === 'paid') {
    awardLoyaltyForOrder(order, company).catch(() => {});
  }

  // Invalidate cached dashboards / notifications so the owner's next poll
  // (TopBar polls every 60s) sees this order immediately instead of a stale
  // result for up to the notifications cache's own 2-minute TTL on top of
  // that. Notifications for storefront orders aren't a separate persisted
  // record — getNotifications() already derives a "New Store Order" entry
  // live from recent Order documents, so once this order exists and the
  // cache is cleared, it just shows up on the next fetch.
  cache.del(`dashboard_${company._id}`);
  const teamUserIds = await User.find({ companyId: company._id }).select('_id').lean();
  teamUserIds.forEach((u) => cache.del(`notifications_${u._id}`));

  const owner = await User.findById(company.owner).select('name email phone');
  emailService.send(storeOrderCustomerEmail(company, order)).catch((e) => logger.warn(`store customer email: ${e.message}`));
  if (owner?.email) {
    emailService.send(storeOrderOwnerEmail(company, order, owner)).catch((e) => logger.warn(`store owner email: ${e.message}`));
  }

  const smsOk = company.smsSettings?.enabled !== false;
  if (smsOk && company.smsSettings?.sendOrderSMS !== false && order.customer?.phone) {
    sendOrderConfirmationSMS(order.customer.phone, order.customer.name, order.orderNumber, order.total).catch(() => {});
  }
  if (smsOk && company.smsSettings?.sendOrderSMS !== false && owner?.phone) {
    sendStoreOrderSMS(owner.phone, owner.name, order.customer?.name || 'A customer', order.total, company.companyName).catch(() => {});
  }

  console.log(`Order created: ${order.orderNumber} — ${naira(order.total)} — method: ${order.paymentMethod} — io present: ${Boolean(io)}`);
  if (io) {
    io.to(`company:${company._id}`).emit('order:new', {
      orderId: order._id,
      orderNumber: order.orderNumber,
      customerName: order.customer?.name || 'A customer',
      amount: order.total,
      items: order.items.length,
      source: 'storefront',
      message: `New order from ${order.customer?.name || 'a customer'} — ${naira(order.total)}`,
    });
    io.to(`company:${company._id}`).emit('notification:refresh', { type: 'store_order', orderNumber: order.orderNumber });
    if (anyLow) io.to(`company:${company._id}`).emit('notification:refresh', { type: 'low_stock' });
  }

  logger.warn(`Storefront order ${order.orderNumber} placed for company ${company._id} (${naira(order.total)}, ${order.paymentMethod})`);
}

// ── Pay-on-delivery / bank-transfer order creation — no Paystack step,
// the order exists the moment the customer submits checkout. ─────────────
async function createDirectOrder(company, meta, { io } = {}) {
  const orderNumber = await nextOrderNumber(company._id);
  const order = await Order.create({
    companyId: company._id,
    orderNumber,
    source: 'storefront',
    customer: meta.customer,
    items: meta.items,
    subtotal: meta.subtotal,
    deliveryFee: meta.deliveryFee,
    discount: meta.discount,
    couponCode: meta.couponCode,
    loyaltyPointsUsed: meta.loyaltyRedeemed?.points || 0,
    loyaltyDiscount: meta.loyaltyRedeemed?.discount || 0,
    total: meta.total,
    currency: 'NGN',
    paymentMethod: meta.paymentMethod,
    status: 'pending',
    paymentStatus: 'unpaid',
    notes: meta.notes,
    stockApplied: false,
    timeline: [{
      status: 'pending',
      description: meta.paymentMethod === 'pay_on_delivery' ? 'Order placed — to be paid on delivery' : 'Order placed — awaiting bank transfer confirmation',
      timestamp: new Date(),
    }],
  });
  await finalizePlacedOrder(company, order, { io });
  return order;
}

// ── Shared fulfilment for Paystack payments (called by verify + webhook,
// idempotent on paystackReference) ───────────────────────────────────────
async function fulfilStorefrontOrder(company, txn, { io } = {}) {
  const reference = txn.reference;
  const existing = await Order.findOne({ paystackReference: reference });
  if (existing) return existing;

  const meta = txn.metadata || {};
  const cust = meta.customer || {};
  // Checkout already resolved pricing/variants/stock at initialization —
  // trust the metadata's item list rather than re-resolving it, same as the
  // total is trusted from txn.amount (the actual amount Paystack charged).
  const items = Array.isArray(meta.items) ? meta.items : [];
  const isSplit = meta.paymentMethod === 'split_payment';
  const orderTotal = meta.orderTotal != null ? Number(meta.orderTotal) : (txn.amount || 0) / 100;
  const chargedNow = (txn.amount || 0) / 100;

  const orderNumber = await nextOrderNumber(company._id);

  let order;
  try {
    order = await Order.create({
      companyId: company._id,
      orderNumber,
      source: 'storefront',
      paystackReference: reference,
      customer: { name: cust.name, email: cust.email, phone: cust.phone, address: cust.address, city: cust.city, state: cust.state },
      items,
      subtotal: meta.subtotal,
      deliveryFee: meta.deliveryFee,
      discount: meta.discount,
      couponCode: meta.couponCode,
      loyaltyPointsUsed: meta.loyaltyRedeemed?.points || 0,
      loyaltyDiscount: meta.loyaltyRedeemed?.discount || 0,
      total: orderTotal,
      currency: 'NGN',
      paymentMethod: isSplit ? 'split_payment' : 'paystack',
      status: 'confirmed',
      paymentStatus: isSplit ? 'partial' : 'paid',
      splitPayment: isSplit ? { firstAmount: chargedNow, secondAmount: Math.round((orderTotal - chargedNow) * 100) / 100 } : undefined,
      notes: cust.notes,
      stockApplied: false,
      timeline: [{
        status: 'confirmed',
        description: isSplit ? `Paid ${naira(chargedNow)} online — ${naira(orderTotal - chargedNow)} due on delivery` : 'Paid online via storefront',
        timestamp: new Date(),
      }],
    });
  } catch (err) {
    if (err.code === 11000) {
      const again = await Order.findOne({ paystackReference: reference });
      if (again) return again;
    }
    throw err;
  }

  await finalizePlacedOrder(company, order, { io });
  return order;
}
exports.fulfilStorefrontOrder = fulfilStorefrontOrder;
exports.findStore = findStore;
exports.publicProduct = publicProduct;

// ── Email builders ─────────────────────────────────────────────────
function orderRows(order) {
  return order.items.map((i) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;">${i.name} × ${i.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;text-align:right;">${naira(i.price * i.quantity)}</td>
    </tr>`).join('');
}

function storeOrderCustomerEmail(company, order) {
  const html = emailService.baseTemplate('Order Confirmed', `
    <h2 style="color:#0f172a;margin:0 0 6px;">Thank you for your order! 🎉</h2>
    <p style="color:#475569;font-size:14px;margin:0 0 20px;">
      Your order <strong>${order.orderNumber}</strong> from <strong>${company.companyName}</strong> has been received and paid for.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px;">
      ${orderRows(order)}
      <tr><td style="padding:10px 12px;font-weight:700;font-size:15px;">Total</td>
      <td style="padding:10px 12px;font-weight:700;font-size:15px;text-align:right;">${naira(order.total)}</td></tr>
    </table>
    <p style="color:#64748b;font-size:13px;margin:0;">${company.companyName} will be in touch about delivery. Reply to this email if you have any questions.</p>
  `);
  return {
    to: order.customer.email,
    subject: `Order ${order.orderNumber} confirmed — ${company.companyName}`,
    html,
    text: `Your order ${order.orderNumber} from ${company.companyName} is confirmed. Total: ${naira(order.total)}.`,
  };
}

function storeOrderOwnerEmail(company, order, owner) {
  const html = emailService.baseTemplate('New Store Order', `
    <h2 style="color:#0f172a;margin:0 0 6px;">You have a new order! 💰</h2>
    <p style="color:#475569;font-size:14px;margin:0 0 20px;">
      ${order.customer.name || 'A customer'} just placed order <strong>${order.orderNumber}</strong> on your BizlyAI store.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px;">
      ${orderRows(order)}
      <tr><td style="padding:10px 12px;font-weight:700;">Total paid</td>
      <td style="padding:10px 12px;font-weight:700;text-align:right;">${naira(order.total)}</td></tr>
    </table>
    <p style="color:#475569;font-size:13px;margin:0 0 4px;"><strong>Customer:</strong> ${order.customer.name || '—'}</p>
    <p style="color:#475569;font-size:13px;margin:0 0 4px;"><strong>Email:</strong> ${order.customer.email || '—'}</p>
    <p style="color:#475569;font-size:13px;margin:0 0 4px;"><strong>Phone:</strong> ${order.customer.phone || '—'}</p>
    ${order.customer.address ? `<p style="color:#475569;font-size:13px;margin:0 0 4px;"><strong>Address:</strong> ${order.customer.address}</p>` : ''}
    <p style="margin:20px 0 0;"><a href="${clientUrl()}/orders" style="background:#6366f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">View order</a></p>
  `);
  return {
    to: owner.email,
    subject: `New order ${order.orderNumber} — ${naira(order.total)}`,
    html,
    text: `New store order ${order.orderNumber} from ${order.customer.name || 'a customer'} — ${naira(order.total)}.`,
  };
}
