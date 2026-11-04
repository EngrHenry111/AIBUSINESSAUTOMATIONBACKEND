'use strict';

// Quick Sale: selling at the counter. A sale is saved as an Order with
// source 'pos', so it already counts in revenue, Profit & Loss, customer
// history and stock reports. Prices and stock are worked out here, never
// taken from the till, and stock is taken off atomically so two tills can't
// both sell the last item.

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const StockLog = require('../models/StockLog');
const SaleCounter = require('../models/SaleCounter');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { isLowStock, notifyLowStock } = require('./productController');
const { releaseOrderStock, awardLoyaltyForOrder } = require('./orderController');
const { recordCustomerTransaction } = require('../utils/customerSync');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const METHODS = ['cash', 'transfer', 'pos_terminal', 'credit'];
const METHOD_LABEL = { cash: 'Cash', transfer: 'Transfer', pos_terminal: 'POS', credit: 'Credit (pay later)' };
const MANAGERS = ['company_owner', 'manager', 'super_admin'];
const MAX_LINES = 100;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isManager = (user) => MANAGERS.includes(user.role);

// Start and end of a calendar day in Lagos (the app's business timezone).
function lagosDay(dateStr) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : today;
  const start = new Date(`${day}T00:00:00+01:00`);
  return { day, start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function effectivePrice(p) {
  if (p.isFlashSale && p.flashSalePrice != null && (!p.flashSaleEndsAt || new Date(p.flashSaleEndsAt) > new Date())) return p.flashSalePrice;
  return p.price;
}

// ── GET /pos/products ─────────────────────────────────────────────────────
// Everything the till needs, in one go, so searching is instant on the
// device even on a slow connection.
exports.getProducts = async (req, res, next) => {
  try {
    const products = await Product.find({ companyId: req.companyId, status: { $ne: 'inactive' } })
      .select('name price sku category images stock variants isFlashSale flashSalePrice flashSaleEndsAt unit')
      .sort({ sold: -1, name: 1 }).limit(3000).lean();
    res.status(200).json({
      success: true,
      data: products.map((p) => ({
        id: String(p._id),
        name: p.name,
        price: effectivePrice(p),
        sku: p.sku || '',
        category: p.category || '',
        unit: p.unit || '',
        image: p.images?.[0] || '',
        stock: p.stock?.trackStock === false ? null : (p.stock?.quantity ?? 0),
        canOversell: Boolean(p.stock?.allowOutOfStock),
        options: (p.variants || []).flatMap((v) => (v.options || []).filter((o) => o.value).map((o) => ({
          label: `${v.name}: ${o.value}`, price: o.price != null ? o.price : null,
        }))),
      })),
    });
  } catch (err) { next(err); }
};

// What the till and the receipt show for one sale.
function saleView(order, company) {
  return {
    id: String(order._id),
    number: order.orderNumber,
    createdAt: order.createdAt,
    items: (order.items || []).map((i) => ({
      name: i.name, variant: i.variant || '', quantity: i.quantity, price: i.price, lineTotal: round2(i.price * i.quantity),
    })),
    subtotal: order.subtotal,
    discount: order.discount || 0,
    total: order.total,
    currency: order.currency,
    paymentMethod: order.paymentMethod,
    paymentLabel: METHOD_LABEL[order.paymentMethod] || order.paymentMethod,
    paymentStatus: order.paymentStatus,
    amountTendered: order.pos?.amountTendered ?? null,
    change: order.pos?.change ?? null,
    soldBy: order.pos?.soldByName || '',
    soldById: order.createdBy ? String(order.createdBy) : null,
    customer: order.customer?.name || order.customer?.phone ? { name: order.customer.name || '', phone: order.customer.phone || '', email: order.customer.email || '' } : null,
    voided: order.status === 'cancelled',
    voidReason: order.pos?.voidReason || '',
    ...(company && {
      business: {
        name: company.companyName, logo: company.logo || '',
        phone: company.profile?.phone || '', address: company.profile?.address || '',
      },
    }),
  };
}

// Put back stock taken for a sale that then failed to save.
async function giveBack(taken) {
  for (const t of taken) {
    await Product.updateOne({ _id: t.productId }, { $inc: { 'stock.quantity': t.qty, sold: -(t.sold ?? t.qty) } }).catch(() => {});
  }
}

async function nextSaleNumber(companyId, year) {
  const c = await SaleCounter.findOneAndUpdate(
    { companyId, key: `pos:${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true },
  ).lean();
  return c.seq;
}

const companyForReceipt = (id) => Company.findById(id).select('companyName logo profile.phone profile.address defaultCurrency storeSlug').lean();

// ── POST /pos/sales ───────────────────────────────────────────────────────
exports.createSale = async (req, res, next) => {
  const taken = []; // stock already taken off, to give back if the sale fails
  try {
    const body = req.body || {};
    const clientRef = typeof body.clientRef === 'string' && /^[\w-]{8,64}$/.test(body.clientRef) ? body.clientRef : undefined;

    // The till retries on a bad network: the same sale must not be saved twice.
    if (clientRef) {
      const existing = await Order.findOne({ companyId: req.companyId, clientRef });
      if (existing) return res.status(200).json({ success: true, repeated: true, data: saleView(existing, await companyForReceipt(req.companyId)) });
    }

    const lines = Array.isArray(body.items) ? body.items : [];
    if (!lines.length) return next(new AppError('Add at least one product to the sale.', 400));
    if (lines.length > MAX_LINES) return next(new AppError(`A sale can have at most ${MAX_LINES} lines.`, 400));

    const method = body.paymentMethod;
    if (!METHODS.includes(method)) return next(new AppError('Choose how the customer paid.', 400));

    const ids = [...new Set(lines.map((l) => String(l.productId || '')))];
    if (ids.some((id) => !mongoose.isValidObjectId(id))) return next(new AppError('One of the products is not valid. Refresh and try again.', 400));
    const products = await Product.find({ _id: { $in: ids }, companyId: req.companyId, status: { $ne: 'inactive' } });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    // Build the lines from the product records: price comes from here only.
    const items = [];
    const qtyByProduct = new Map();
    for (const l of lines) {
      const p = byId.get(String(l.productId));
      if (!p) return next(new AppError('One of the products is no longer for sale. Refresh the product list.', 400));
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return next(new AppError(`Check the quantity for ${p.name}.`, 400));
      let price = effectivePrice(p);
      let variant = '';
      if (l.option) {
        const opt = (p.variants || []).flatMap((v) => (v.options || []).map((o) => ({ label: `${v.name}: ${o.value}`, price: o.price })))
          .find((o) => o.label === String(l.option));
        if (!opt) return next(new AppError(`That option for ${p.name} no longer exists. Refresh the product list.`, 400));
        variant = opt.label;
        if (opt.price != null) price = opt.price;
      }
      items.push({ productId: p._id, name: p.name, image: p.images?.[0], variant, quantity: qty, price: round2(price), sku: p.sku });
      qtyByProduct.set(String(p._id), (qtyByProduct.get(String(p._id)) || 0) + qty);
    }

    const subtotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
    const discount = round2(Math.max(0, Number(body.discount) || 0));
    if (discount > subtotal) return next(new AppError('The discount is more than the sale.', 400));
    const total = round2(subtotal - discount);

    const customer = {
      name: String(body.customer?.name || '').trim().slice(0, 120),
      phone: String(body.customer?.phone || '').trim().slice(0, 30),
      email: String(body.customer?.email || '').trim().toLowerCase().slice(0, 200),
    };
    if (customer.email && !/^\S+@\S+\.\S+$/.test(customer.email)) return next(new AppError('The customer email does not look right.', 400));
    if (method === 'credit' && (!customer.name || !customer.phone)) {
      return next(new AppError('For a credit sale, add the customer\'s name and phone so you can collect the money later.', 400));
    }

    let amountTendered = null;
    let change = null;
    if (method === 'cash' && body.amountTendered !== undefined && body.amountTendered !== null && body.amountTendered !== '') {
      amountTendered = round2(Number(body.amountTendered));
      if (!Number.isFinite(amountTendered) || amountTendered < total) return next(new AppError('The cash received is less than the total.', 400));
      change = round2(amountTendered - total);
    }

    // Take stock off atomically, one product at a time.
    for (const [id, qty] of qtyByProduct) {
      const p = byId.get(id);
      const tracked = p.stock?.trackStock !== false;
      if (tracked && !p.stock?.allowOutOfStock) {
        const r = await Product.updateOne(
          { _id: p._id, companyId: req.companyId, 'stock.quantity': { $gte: qty } },
          { $inc: { 'stock.quantity': -qty, sold: qty } },
        );
        if (!r.modifiedCount) {
          await giveBack(taken);
          const fresh = await Product.findById(p._id).select('stock.quantity').lean();
          const left = Math.max(0, fresh?.stock?.quantity ?? 0);
          return next(new AppError(left ? `Only ${left} ${p.name} left in stock.` : `${p.name} is out of stock.`, 409));
        }
        taken.push({ productId: p._id, qty });
      } else if (tracked) {
        // Overselling allowed: stock bottoms out at 0, like elsewhere in the app.
        const before = p.stock?.quantity ?? 0;
        const takeNow = Math.min(qty, Math.max(0, before));
        await Product.updateOne({ _id: p._id }, { $inc: { 'stock.quantity': -takeNow, sold: qty } });
        taken.push({ productId: p._id, qty: takeNow, sold: qty });
      } else {
        await Product.updateOne({ _id: p._id }, { $inc: { sold: qty } });
        taken.push({ productId: p._id, qty: 0, sold: qty });
      }
    }

    const company = await companyForReceipt(req.companyId);
    const order = new Order({
      companyId: req.companyId,
      source: 'pos',
      customer: { ...customer, name: customer.name || 'Walk-in customer' },
      items,
      subtotal,
      discount,
      total,
      currency: company?.defaultCurrency || 'NGN',
      paymentMethod: method,
      paymentStatus: method === 'credit' ? 'unpaid' : 'paid',
      status: 'delivered',
      deliveredAt: new Date(),
      stockApplied: true,
      timeline: [{ status: 'delivered', description: `Sold at the counter by ${req.user.name || 'staff'}` }],
      notes: String(body.note || '').trim().slice(0, 500) || undefined,
      createdBy: req.user._id,
      pos: { soldByName: req.user.name || '', amountTendered, change },
      clientRef,
    });

    // Sale numbers: POS-2026-00001, from an atomic counter.
    const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }).slice(0, 4);
    for (let attempt = 0; ; attempt += 1) {
      order.orderNumber = `POS-${year}-${String(await nextSaleNumber(req.companyId, year)).padStart(5, '0')}`;
      try {
        await order.save();
        break;
      } catch (e) {
        if (e.code === 11000 && /clientRef/.test(e.message) && clientRef) {
          await giveBack(taken);
          const existing = await Order.findOne({ companyId: req.companyId, clientRef });
          return res.status(200).json({ success: true, repeated: true, data: saleView(existing, company) });
        }
        if (e.code !== 11000 || attempt >= 5) throw e;
      }
    }
    taken.length = 0; // saved: the stock is the sale's now

    // Stock log, status and low-stock alerts.
    const after = await Product.find({ _id: { $in: [...qtyByProduct.keys()] } });
    for (const p of after) {
      const qty = qtyByProduct.get(String(p._id));
      const before = byId.get(String(p._id));
      if (p.stock?.trackStock !== false) {
        const prevQty = before.stock?.quantity ?? 0;
        StockLog.create({
          companyId: req.companyId, productId: p._id, adjustment: -qty, reason: 'sale',
          note: `Quick Sale ${order.orderNumber}`, previousQuantity: prevQty, newQuantity: p.stock.quantity,
          orderId: order._id, createdBy: req.user._id,
        }).catch(() => {});
        const status = p.status;
        p.syncStatus();
        if (p.status !== status) await Product.updateOne({ _id: p._id }, { status: p.status });
        if (isLowStock(p) && !isLowStock(before)) notifyLowStock(p);
      }
    }

    recordCustomerTransaction({
      companyId: req.companyId, customer: order.customer, amount: total, countsAsOrder: true, userId: req.user._id,
    }).catch(() => {});
    if (order.paymentStatus === 'paid' && customer.email) awardLoyaltyForOrder(order, company).catch(() => {});
    cache.del(`dashboard_${req.companyId}`);
    const io = req.app.get('io');
    if (io) io.to(`company:${req.companyId}`).emit('pos:sale', { id: String(order._id) });

    res.status(201).json({ success: true, data: saleView(order, company) });
  } catch (err) {
    await giveBack(taken);
    logger.error(`Quick Sale failed: ${err.message}`);
    next(err);
  }
};

// ── GET /pos/sales?date=YYYY-MM-DD&seller=<userId> ───────────────────────
// The day's sales. Salespeople see their own; managers see everyone's.
exports.getSales = async (req, res, next) => {
  try {
    const { day, start, end } = lagosDay(req.query.date);
    const filter = { companyId: req.companyId, source: 'pos', createdAt: { $gte: start, $lt: end } };
    const manager = isManager(req.user);
    if (!manager) filter.createdBy = req.user._id;
    else if (req.query.seller && mongoose.isValidObjectId(req.query.seller)) filter.createdBy = new mongoose.Types.ObjectId(req.query.seller);

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
    const live = orders.filter((o) => o.status !== 'cancelled');
    const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
    const sellers = new Map();
    let items = 0;
    for (const o of live) {
      byMethod[o.paymentMethod] = round2((byMethod[o.paymentMethod] || 0) + o.total);
      items += (o.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
      const key = String(o.createdBy || '');
      const s = sellers.get(key) || { id: key, name: o.pos?.soldByName || 'Staff', total: 0, count: 0 };
      s.total = round2(s.total + o.total); s.count += 1;
      sellers.set(key, s);
    }
    const total = round2(live.reduce((s, o) => s + o.total, 0));
    res.status(200).json({
      success: true,
      data: {
        date: day,
        scope: manager ? 'everyone' : 'mine',
        totals: {
          sales: total, count: live.length, items, discount: round2(live.reduce((s, o) => s + (o.discount || 0), 0)),
          collected: round2(total - byMethod.credit), owed: byMethod.credit, voided: orders.length - live.length,
        },
        byMethod,
        bySeller: [...sellers.values()].sort((a, b) => b.total - a.total),
        sales: orders.slice(0, 300).map((o) => saleView(o)),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /pos/sales/:id ────────────────────────────────────────────────────
exports.getSale = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Sale not found.', 404));
    const order = await Order.findOne({ _id: req.params.id, companyId: req.companyId, source: 'pos' });
    if (!order) return next(new AppError('Sale not found.', 404));
    res.status(200).json({ success: true, data: saleView(order, await companyForReceipt(req.companyId)) });
  } catch (err) { next(err); }
};

// ── POST /pos/sales/:id/void (managers) ───────────────────────────────────
// Cancels a sale made in error and puts its stock back.
exports.voidSale = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Sale not found.', 404));
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) return next(new AppError('Say why this sale is being cancelled.', 400));
    // Claim it first so two managers can't void (and restock) the same sale twice.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId, source: 'pos', status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled' } },
      { new: true },
    );
    if (!order) return next(new AppError('Sale not found, or it was already cancelled.', 404));
    await releaseOrderStock(order, req.user._id);
    order.paymentStatus = order.paymentStatus === 'paid' ? 'refunded' : order.paymentStatus;
    order.pos = { ...(order.pos?.toObject?.() || order.pos || {}), voidedAt: new Date(), voidedBy: req.user._id, voidReason: reason };
    order.timeline.push({ status: 'cancelled', description: `Cancelled by ${req.user.name || 'a manager'}: ${reason}` });
    await order.save();
    if (order.customer?.phone || order.customer?.email) {
      recordCustomerTransaction({ companyId: req.companyId, customer: order.customer, amount: -order.total, countsAsOrder: false }).catch(() => {});
    }
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id, action: 'pos_sale_voided', resource: 'Order', resourceId: order._id,
      description: `Cancelled Quick Sale ${order.orderNumber} (${order.currency} ${order.total}): ${reason}`, ip: req.ip,
    });
    cache.del(`dashboard_${req.companyId}`);
    res.status(200).json({ success: true, data: saleView(order, await companyForReceipt(req.companyId)) });
  } catch (err) { next(err); }
};
