'use strict';

const Order = require('../models/Order');
const Product = require('../models/Product');
const { runAgent } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');
const { applyStockAdjustment } = require('./productController');
const { recordCustomerTransaction } = require('../utils/customerSync');

const RELEASES_STOCK = ['cancelled', 'refunded'];

// Deduct stock for every line item that references a product (once per order).
async function commitOrderStock(order, userId, io) {
  if (order.stockApplied) return;
  let anyLow = false;
  for (const item of order.items || []) {
    if (!item.productId || !item.quantity) continue;
    const product = await Product.findById(item.productId);
    if (!product || !product.stock.trackStock) continue;
    const { low } = await applyStockAdjustment(product, -Math.abs(item.quantity), {
      reason: 'sale', orderId: order._id, userId, note: `Order ${order.orderNumber}`,
    });
    if (low) anyLow = true;
  }
  order.stockApplied = true;
  if (anyLow && io) io.to(`company:${order.companyId}`).emit('notification:refresh', { type: 'low_stock' });
}

// Return stock to inventory when an applied order is cancelled/refunded.
async function releaseOrderStock(order, userId) {
  if (!order.stockApplied) return;
  for (const item of order.items || []) {
    if (!item.productId || !item.quantity) continue;
    const product = await Product.findById(item.productId);
    if (!product || !product.stock.trackStock) continue;
    await applyStockAdjustment(product, Math.abs(item.quantity), {
      reason: 'return', orderId: order._id, userId, note: `Order ${order.orderNumber} ${order.status}`,
    });
  }
  order.stockApplied = false;
}

exports.getOrders = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (search) filter.$or = [
      { orderNumber: { $regex: search, $options: 'i' } },
      { 'customer.name': { $regex: search, $options: 'i' } },
      { 'customer.email': { $regex: search, $options: 'i' } },
    ];
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Order.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: orders, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

exports.createOrder = async (req, res, next) => {
  try {
    const count = await Order.countDocuments({ companyId: req.companyId });
    const orderNumber = `ORD-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    const order = await Order.create({ ...req.body, companyId: req.companyId, orderNumber, createdBy: req.user._id });

    if (!RELEASES_STOCK.includes(order.status)) {
      await commitOrderStock(order, req.user._id, req.app.get('io'));
      await order.save();
    }

    await recordCustomerTransaction({
      companyId: req.companyId, customer: order.customer, amount: order.total,
      countsAsOrder: true, date: order.createdAt, userId: req.user._id,
    });

    require('../utils/cache').del(`dashboard_${req.companyId}`);
    res.status(201).json({ success: true, data: order });
  } catch (err) { next(err); }
};

exports.getOrder = async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!order) return next(new AppError('Order not found.', 404));
    res.status(200).json({ success: true, data: order });
  } catch (err) { next(err); }
};

exports.updateOrder = async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!order) return next(new AppError('Order not found.', 404));

    const newStatus = req.body.status;
    const statusChanged = newStatus && newStatus !== order.status;

    // Add timeline entry on status change
    if (statusChanged) {
      order.timeline.push({ status: newStatus, description: `Status changed to ${newStatus}`, timestamp: new Date() });
    }
    Object.assign(order, req.body);

    if (statusChanged) {
      if (newStatus === 'delivered') order.deliveredAt = order.deliveredAt || new Date();
      if (RELEASES_STOCK.includes(newStatus)) {
        await releaseOrderStock(order, req.user._id);
      } else {
        await commitOrderStock(order, req.user._id, req.app.get('io'));
      }
    }

    await order.save();
    require('../utils/cache').del(`dashboard_${req.companyId}`);
    res.status(200).json({ success: true, data: order });
  } catch (err) { next(err); }
};

exports.getOrderStatus = async (req, res, next) => {
  try {
    const { orderNumber } = req.params;
    const order = await Order.findOne({ companyId: req.companyId, orderNumber }).select('orderNumber status timeline trackingNumber carrier estimatedDelivery customer');
    if (!order) return next(new AppError('Order not found.', 404));

    const statusSummary = await runAgent('knowledge_assistant',
      `Provide a friendly customer-facing status update for order ${order.orderNumber}. Current status: ${order.status}. Tracking: ${order.trackingNumber || 'Not available'}. Estimated delivery: ${order.estimatedDelivery ? new Date(order.estimatedDelivery).toDateString() : 'TBD'}.`
    );

    res.status(200).json({ success: true, data: { ...order.toJSON(), statusMessage: statusSummary } });
  } catch (err) { next(err); }
};

exports.deleteOrder = async (req, res, next) => {
  try {
    const order = await Order.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!order) return next(new AppError('Order not found.', 404));
    res.status(200).json({ success: true, message: 'Order deleted.' });
  } catch (err) { next(err); }
};
