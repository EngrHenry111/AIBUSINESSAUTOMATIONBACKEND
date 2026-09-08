'use strict';

const fs = require('fs');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockLog = require('../models/StockLog');
const Order = require('../models/Order');
const { cloudinary } = require('../config/cloudinary');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const REASONS = ['restock', 'sale', 'damage', 'lost', 'return', 'manual', 'correction'];
const genSku = () => `BIZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

function isLow(p) {
  return p.stock?.trackStock && p.stock.quantity <= (p.stock.lowStockThreshold ?? 5);
}

// ── Shared: apply a stock delta, log it, keep status in sync ─────────────
async function applyStockAdjustment(product, adjustment, opts = {}) {
  const prev = product.stock.quantity;
  const next = Math.max(0, prev + Number(adjustment || 0));
  product.stock.quantity = next;
  if (opts.reason === 'sale' && adjustment < 0) product.sold = (product.sold || 0) + Math.abs(adjustment);
  product.syncStatus();
  await product.save();

  await StockLog.create({
    companyId: product.companyId,
    productId: product._id,
    adjustment: Number(adjustment),
    reason: REASONS.includes(opts.reason) ? opts.reason : 'manual',
    note: opts.note,
    previousQuantity: prev,
    newQuantity: next,
    orderId: opts.orderId,
    createdBy: opts.userId,
  });

  cache.del(`dashboard_${product.companyId}`);
  return { previousQuantity: prev, newQuantity: next, low: isLow(product) };
}
exports.applyStockAdjustment = applyStockAdjustment;

// ── Cloudinary upload for one local image ──────────────────────────────
async function uploadImageFile(localPath, companyId) {
  if (!cloudinary) {
    return `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${localPath.split(/[\\/]/).pop()}`;
  }
  const r = await cloudinary.uploader.upload(localPath, {
    folder: `business-ai/${companyId}/products`,
    resource_type: 'image',
    transformation: [{ width: 900, height: 900, crop: 'limit' }],
  });
  fs.unlink(localPath, () => {});
  return r.secure_url;
}

// ── GET /products ──────────────────────────────────────────────────────
exports.getProducts = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 24);
    const { category, status, search, sort = 'createdAt', order = 'desc' } = req.query;

    const q = { companyId: req.companyId };
    if (category) q.category = category;
    if (status === 'low_stock') {
      q.status = { $ne: 'inactive' };
      q['stock.trackStock'] = true;
      q.$expr = { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] };
    } else if (status) {
      q.status = status;
    }
    if (search && search.trim()) {
      const rx = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      q.$or = [{ name: rx }, { sku: rx }, { description: rx }];
    }

    const sortField = ['name', 'price', 'createdAt'].includes(sort) ? sort
      : sort === 'stock' ? 'stock.quantity' : 'createdAt';
    const sortSpec = { [sortField]: order === 'asc' ? 1 : -1 };

    const [products, total, statusAgg, lowStock] = await Promise.all([
      Product.find(q).sort(sortSpec).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(q),
      Product.aggregate([
        { $match: { companyId: req.companyId } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
      Product.countDocuments({
        companyId: req.companyId, status: { $ne: 'inactive' }, 'stock.trackStock': true,
        $expr: { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] },
      }),
    ]);

    const s = statusAgg.reduce((a, x) => { a[x._id] = x.n; return a; }, {});
    res.status(200).json({
      success: true,
      data: products,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      stats: {
        total: Object.values(s).reduce((a, b) => a + b, 0),
        active: s.active || 0,
        outOfStock: s.out_of_stock || 0,
        inactive: s.inactive || 0,
        lowStock,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /products/categories ──────────────────────────────────────────
exports.getCategories = async (req, res, next) => {
  try {
    const cats = await Product.distinct('category', { companyId: req.companyId, category: { $nin: [null, ''] } });
    res.status(200).json({ success: true, data: cats.sort() });
  } catch (err) { next(err); }
};

// ── GET /products/low-stock ───────────────────────────────────────────
exports.getLowStockProducts = async (req, res, next) => {
  try {
    const products = await Product.find({
      companyId: req.companyId, status: { $ne: 'inactive' }, 'stock.trackStock': true,
      $expr: { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] },
    }).sort({ 'stock.quantity': 1 }).lean();
    res.status(200).json({ success: true, data: products });
  } catch (err) { next(err); }
};

// ── GET /products/:id ─────────────────────────────────────────────────
exports.getProduct = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Product not found.', 404));
    const product = await Product.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('createdBy', 'name').lean();
    if (!product) return next(new AppError('Product not found.', 404));

    const [stockHistory, orders] = await Promise.all([
      StockLog.find({ productId: product._id }).populate('createdBy', 'name').sort({ createdAt: -1 }).limit(50).lean(),
      Order.find({ companyId: req.companyId, 'items.productId': product._id })
        .select('orderNumber status total currency createdAt items customer').sort({ createdAt: -1 }).limit(25).lean(),
    ]);

    const revenue = orders.reduce((sum, o) => {
      const line = (o.items || []).filter((it) => String(it.productId) === String(product._id));
      return sum + line.reduce((s, it) => s + (it.price || 0) * (it.quantity || 0), 0);
    }, 0);

    res.status(200).json({
      success: true,
      data: {
        ...product,
        stockHistory,
        sales: {
          totalSold: product.sold || 0,
          revenue,
          orders: orders.map((o) => ({
            _id: o._id, orderNumber: o.orderNumber, status: o.status,
            customer: o.customer?.name, createdAt: o.createdAt,
            quantity: (o.items || []).filter((it) => String(it.productId) === String(product._id))
              .reduce((s, it) => s + (it.quantity || 0), 0),
          })),
        },
      },
    });
  } catch (err) { next(err); }
};

// ── POST /products ────────────────────────────────────────────────────
exports.createProduct = async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (!body.name || body.price == null) return next(new AppError('Name and price are required.', 400));

    // Uploaded files (multipart) → Cloudinary
    if (req.files?.length) {
      const urls = [];
      for (const f of req.files) {
        try { urls.push(await uploadImageFile(f.path, req.companyId)); }
        catch (e) { logger.warn(`Product image upload failed: ${e.message}`); }
      }
      body.images = [...(Array.isArray(body.images) ? body.images : []), ...urls];
    }

    let sku = (body.sku || '').trim() || genSku();
    // ensure unique per company
    for (let i = 0; i < 5 && await Product.exists({ companyId: req.companyId, sku }); i++) sku = genSku();
    body.sku = sku;

    if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (typeof body.stock === 'string') { try { body.stock = JSON.parse(body.stock); } catch { body.stock = undefined; } }

    const product = await Product.create({ ...body, companyId: req.companyId, createdBy: req.user._id });
    product.syncStatus();
    await product.save();

    if (product.stock.trackStock && product.stock.quantity > 0) {
      await StockLog.create({
        companyId: req.companyId, productId: product._id, adjustment: product.stock.quantity,
        reason: 'restock', previousQuantity: 0, newQuantity: product.stock.quantity, createdBy: req.user._id,
      });
    }

    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'product.create', resource: 'Product', resourceId: product._id, description: product.name, ip: req.ip });
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A product with that SKU already exists.', 409));
    next(err);
  }
};

// ── POST /products/:id/images ─────────────────────────────────────────
exports.uploadImages = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!product) return next(new AppError('Product not found.', 404));
    if (!req.files?.length) return next(new AppError('No images received.', 400));
    if (product.images.length + req.files.length > 5) {
      req.files.forEach((f) => fs.unlink(f.path, () => {}));
      return next(new AppError('A product can have at most 5 images.', 400));
    }

    for (const f of req.files) {
      try { product.images.push(await uploadImageFile(f.path, req.companyId)); }
      catch (e) { logger.warn(`Product image upload failed: ${e.message}`); }
    }
    await product.save();
    res.status(200).json({ success: true, data: { images: product.images } });
  } catch (err) { next(err); }
};

// ── PUT /products/:id ─────────────────────────────────────────────────
exports.updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!product) return next(new AppError('Product not found.', 404));

    const body = { ...req.body };
    if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);

    const prevQty = product.stock.quantity;
    const nextQtyRequested = body.stock?.quantity;

    // Apply everything except a direct stock.quantity jump (log that separately)
    const stockFromBody = body.stock;
    delete body.stock;
    Object.assign(product, body);
    if (stockFromBody) {
      product.stock.lowStockThreshold = stockFromBody.lowStockThreshold ?? product.stock.lowStockThreshold;
      product.stock.trackStock = stockFromBody.trackStock ?? product.stock.trackStock;
      product.stock.allowOutOfStock = stockFromBody.allowOutOfStock ?? product.stock.allowOutOfStock;
    }

    if (nextQtyRequested != null && Number(nextQtyRequested) !== prevQty) {
      await applyStockAdjustment(product, Number(nextQtyRequested) - prevQty, {
        reason: 'correction', note: 'Edited from product form', userId: req.user._id,
      });
    } else {
      product.syncStatus();
      await product.save();
    }

    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'product.update', resource: 'Product', resourceId: product._id, ip: req.ip });
    res.status(200).json({ success: true, data: product });
  } catch (err) { next(err); }
};

// ── DELETE /products/:id (soft) ──────────────────────────────────────
exports.deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!product) return next(new AppError('Product not found.', 404));

    const pending = await Order.countDocuments({
      companyId: req.companyId,
      'items.productId': product._id,
      status: { $in: ['pending', 'confirmed', 'processing', 'shipped'] },
    });
    if (pending > 0) {
      return next(new AppError(`This product is in ${pending} open order${pending > 1 ? 's' : ''}. Fulfil or cancel them first.`, 409));
    }

    product.status = 'inactive';
    await product.save();
    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'product.delete', resource: 'Product', resourceId: product._id, ip: req.ip });
    res.status(200).json({ success: true, message: 'Product archived.' });
  } catch (err) { next(err); }
};

// ── POST /products/:id/stock ─────────────────────────────────────────
exports.adjustStock = async (req, res, next) => {
  try {
    const { adjustment, reason, note } = req.body;
    const n = Number(adjustment);
    if (!Number.isFinite(n) || n === 0) return next(new AppError('Provide a non-zero adjustment.', 400));

    const product = await Product.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!product) return next(new AppError('Product not found.', 404));

    const result = await applyStockAdjustment(product, n, { reason, note, userId: req.user._id });

    // Nudge the notification bell if we just crossed into low stock
    if (result.low) {
      const io = req.app.get('io');
      io?.to(`company:${req.companyId}`).emit('notification:refresh', { type: 'low_stock', productId: product._id });
    }

    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'product.stock_adjust', resource: 'Product', resourceId: product._id, description: `${n > 0 ? '+' : ''}${n} (${reason || 'manual'})`, ip: req.ip });
    res.status(200).json({ success: true, data: { product, ...result } });
  } catch (err) { next(err); }
};

// ── GET /products/:id/stock-history ─────────────────────────────────
exports.getStockHistory = async (req, res, next) => {
  try {
    const logs = await StockLog.find({ productId: req.params.id, companyId: req.companyId })
      .populate('createdBy', 'name')
      .populate('orderId', 'orderNumber')
      .sort({ createdAt: -1 }).limit(200).lean();
    res.status(200).json({ success: true, data: logs });
  } catch (err) { next(err); }
};
