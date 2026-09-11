'use strict';

const Company = require('../models/Company');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { paystackAPI } = require('../utils/paystack');
const { applyStockAdjustment } = require('./productController');
const { recordCustomerTransaction } = require('../utils/customerSync');
const emailService = require('../services/emailService');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

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

const publicProduct = (p) => ({
  _id: p._id,
  name: p.name,
  description: p.description,
  price: p.price,
  currency: p.currency || 'NGN',
  images: p.images || [],
  category: p.category || null,
  unit: p.unit || null,
  stock: {
    quantity: p.stock?.trackStock ? p.stock.quantity : null,
    trackStock: Boolean(p.stock?.trackStock),
    lowStockThreshold: p.stock?.lowStockThreshold ?? 5,
    allowOutOfStock: Boolean(p.stock?.allowOutOfStock),
  },
});

// Which products are visible in a given store
function storeProductQuery(company, { category, search } = {}) {
  const q = { companyId: company._id, status: { $ne: 'inactive' } };
  if (!company.storeSettings?.showOutOfStock) {
    q.$or = [
      { 'stock.trackStock': false },
      { 'stock.quantity': { $gt: 0 } },
      { 'stock.allowOutOfStock': true },
    ];
  }
  if (category) q.category = category;
  if (search && search.trim()) {
    const rx = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    q.$and = [{ $or: [{ name: rx }, { description: rx }, { category: rx }] }];
  }
  return q;
}

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
        store: {
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
        },
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
    const products = await Product.find(storeProductQuery(company, req.query))
      .sort({ createdAt: -1 }).limit(200).lean();
    res.status(200).json({ success: true, data: products.map(publicProduct) });
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

// ── POST /store/:slug/checkout ─────────────────────────────────────
exports.initializeStorePayment = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug, { requirePayments: true });
    const { items = [], customer = {} } = req.body;

    if (!Array.isArray(items) || items.length === 0) return next(new AppError('Your cart is empty.', 400));
    if (!customer.name || !customer.email || !customer.phone) {
      return next(new AppError('Name, email and phone are required.', 400));
    }
    if (!/^\S+@\S+\.\S+$/.test(customer.email)) return next(new AppError('Enter a valid email address.', 400));

    const ids = [...new Set(items.map((i) => String(i.productId)))];
    const products = await Product.find({ _id: { $in: ids }, companyId: company._id, status: { $ne: 'inactive' } });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    let total = 0;
    const lineItems = [];
    for (const it of items) {
      const p = byId.get(String(it.productId));
      const qty = Math.max(1, parseInt(it.quantity, 10) || 0);
      if (!p) return next(new AppError('One of the products is no longer available.', 400));
      if (p.stock?.trackStock && !p.stock.allowOutOfStock && p.stock.quantity < qty) {
        return next(new AppError(`Only ${p.stock.quantity} of "${p.name}" left in stock.`, 400));
      }
      total += p.price * qty;
      lineItems.push({ productId: String(p._id), quantity: qty });
    }
    if (total <= 0) return next(new AppError('Order total must be greater than zero.', 400));

    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email: customer.email,
      amount: Math.round(total * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: {
        type: 'storefront_order',
        companyId: String(company._id),
        slug: company.storeSlug,
        items: lineItems,
        customer: {
          name: String(customer.name).slice(0, 120),
          email: customer.email,
          phone: String(customer.phone).slice(0, 40),
          address: customer.address ? String(customer.address).slice(0, 300) : undefined,
          notes: customer.notes ? String(customer.notes).slice(0, 500) : undefined,
        },
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
        total,
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

    const order = await fulfilStorefrontOrder(company, vr.data, { io: req.app.get('io') });
    res.status(200).json({ success: true, data: { order: publicOrder(order) } });
  } catch (err) { next(err); }
};

const publicOrder = (o) => ({
  orderNumber: o.orderNumber,
  status: o.status,
  paymentStatus: o.paymentStatus,
  total: o.total,
  currency: o.currency || 'NGN',
  customer: { name: o.customer?.name, email: o.customer?.email },
  items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
  createdAt: o.createdAt,
});

// ── Shared fulfilment (called by verify + webhook, idempotent) ────
async function fulfilStorefrontOrder(company, txn, { io } = {}) {
  const reference = txn.reference;
  const existing = await Order.findOne({ paystackReference: reference });
  if (existing) return existing;

  const meta = txn.metadata || {};
  const cust = meta.customer || {};
  const requested = Array.isArray(meta.items) ? meta.items : [];

  const ids = [...new Set(requested.map((i) => String(i.productId)))];
  const products = await Product.find({ _id: { $in: ids }, companyId: company._id });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = requested.map((r) => {
    const p = byId.get(String(r.productId));
    const qty = Math.max(1, parseInt(r.quantity, 10) || 1);
    return {
      productId: p?._id,
      name: p?.name || 'Item',
      quantity: qty,
      price: p?.price || 0,
      sku: p?.sku,
    };
  });

  const total = (txn.amount || 0) / 100;
  const count = await Order.countDocuments({ companyId: company._id });
  const orderNumber = `ORD-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;

  let order;
  try {
    order = await Order.create({
      companyId: company._id,
      orderNumber,
      source: 'storefront',
      paystackReference: reference,
      customer: { name: cust.name, email: cust.email, phone: cust.phone, address: cust.address },
      items,
      total,
      currency: 'NGN',
      status: 'confirmed',
      paymentStatus: 'paid',
      notes: cust.notes,
      stockApplied: false,
      timeline: [{ status: 'confirmed', description: 'Paid online via storefront', timestamp: new Date() }],
    });
  } catch (err) {
    if (err.code === 11000) {
      const again = await Order.findOne({ paystackReference: reference });
      if (again) return again;
    }
    throw err;
  }

  // Reduce stock
  let anyLow = false;
  for (const item of order.items) {
    if (!item.productId || !item.quantity) continue;
    const product = byId.get(String(item.productId));
    if (!product || !product.stock?.trackStock) continue;
    try {
      const { low } = await applyStockAdjustment(product, -Math.abs(item.quantity), {
        reason: 'sale', orderId: order._id, note: `Store order ${order.orderNumber}`,
      });
      if (low) anyLow = true;
    } catch (e) { logger.warn(`Store stock adjust failed: ${e.message}`); }
  }
  order.stockApplied = true;
  await order.save();

  // Customer record + rollups
  await recordCustomerTransaction({
    companyId: company._id, customer: order.customer, amount: total, countsAsOrder: true, date: order.createdAt,
  });

  // Invalidate cached dashboards / notifications
  cache.del(`dashboard_${company._id}`);

  // Emails
  const owner = await User.findById(company.owner).select('name email');
  emailService.send(storeOrderCustomerEmail(company, order)).catch((e) => logger.warn(`store customer email: ${e.message}`));
  if (owner?.email) {
    emailService.send(storeOrderOwnerEmail(company, order, owner)).catch((e) => logger.warn(`store owner email: ${e.message}`));
  }

  if (io) {
    io.to(`company:${company._id}`).emit('notification:refresh', { type: 'store_order', orderNumber: order.orderNumber });
    if (anyLow) io.to(`company:${company._id}`).emit('notification:refresh', { type: 'low_stock' });
  }

  logger.info(`Storefront order ${order.orderNumber} fulfilled for company ${company._id} (${naira(total)})`);
  return order;
}
exports.fulfilStorefrontOrder = fulfilStorefrontOrder;

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
