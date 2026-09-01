'use strict';

const Order = require('../models/Order');
const { runAgent } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');

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

    // Add timeline entry on status change
    if (req.body.status && req.body.status !== order.status) {
      order.timeline.push({ status: req.body.status, description: `Status changed to ${req.body.status}`, timestamp: new Date() });
    }
    Object.assign(order, req.body);
    await order.save();
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
