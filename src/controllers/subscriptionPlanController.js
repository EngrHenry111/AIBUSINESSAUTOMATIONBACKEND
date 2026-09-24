'use strict';

// Store-OWNER side of Store Subscriptions — creating/managing the recurring
// "boxes" a store sells, and seeing/managing who's subscribed to them.
// The customer-facing half (browsing plans, subscribing, pausing their own
// subscription) lives in storeSubscriptionController.js.
const SubscriptionPlan = require('../models/SubscriptionPlan');
const StoreSubscription = require('../models/StoreSubscription');
const Product = require('../models/Product');
const User = require('../models/User');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;
const INTERVALS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'];

async function resolvePlanItems(companyId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('At least one product is required.', 400);
  }
  const ids = [...new Set(items.map((i) => String(i.productId)))];
  const products = await Product.find({ _id: { $in: ids }, companyId });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  return items.map((it) => {
    const p = byId.get(String(it.productId));
    if (!p) throw new AppError('One of the selected products was not found.', 400);
    const quantity = Math.max(1, parseInt(it.quantity, 10) || 1);
    return { productId: p._id, name: p.name, quantity, unitPrice: it.unitPrice ?? p.price };
  });
}

// ── GET /subscription-plans ───────────────────────────────────────────────
exports.getPlans = async (req, res, next) => {
  try {
    const plans = await SubscriptionPlan.find({ companyId: req.companyId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: plans });
  } catch (err) { next(err); }
};

// ── POST /subscription-plans ──────────────────────────────────────────────
exports.createPlan = async (req, res, next) => {
  try {
    const { name, description, image, items, interval, price, originalPrice, deliveryFee, trialDays, maxSubscribers, perks } = req.body;
    if (!name?.trim()) return next(new AppError('Plan name is required.', 400));
    if (!INTERVALS.includes(interval)) return next(new AppError('Invalid delivery interval.', 400));
    if (price == null || Number(price) < 0) return next(new AppError('A valid price is required.', 400));

    const resolvedItems = await resolvePlanItems(req.companyId, items);

    const plan = await SubscriptionPlan.create({
      companyId: req.companyId,
      name: name.trim(),
      description: description?.trim(),
      image,
      items: resolvedItems,
      interval,
      price: Number(price),
      originalPrice: originalPrice != null ? Number(originalPrice) : undefined,
      deliveryFee: Number(deliveryFee) || 0,
      trialDays: Math.max(0, parseInt(trialDays, 10) || 0),
      maxSubscribers: maxSubscribers != null && maxSubscribers !== '' ? Math.max(1, parseInt(maxSubscribers, 10)) : null,
      perks: Array.isArray(perks) ? perks.slice(0, 10).map((p) => String(p).slice(0, 80)) : [],
    });

    res.status(201).json({ success: true, data: plan });
  } catch (err) { next(err); }
};

// ── PUT /subscription-plans/:id ────────────────────────────────────────────
exports.updatePlan = async (req, res, next) => {
  try {
    const plan = await SubscriptionPlan.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!plan) return next(new AppError('Subscription plan not found.', 404));

    const { name, description, image, items, interval, price, originalPrice, deliveryFee, isActive, trialDays, maxSubscribers, perks } = req.body;

    if (name !== undefined) plan.name = String(name).trim();
    if (description !== undefined) plan.description = String(description).trim();
    if (image !== undefined) plan.image = image;
    if (items !== undefined) plan.items = await resolvePlanItems(req.companyId, items);
    if (interval !== undefined) {
      if (!INTERVALS.includes(interval)) return next(new AppError('Invalid delivery interval.', 400));
      plan.interval = interval;
    }
    if (price !== undefined) plan.price = Number(price);
    if (originalPrice !== undefined) plan.originalPrice = originalPrice === null || originalPrice === '' ? undefined : Number(originalPrice);
    if (deliveryFee !== undefined) plan.deliveryFee = Number(deliveryFee) || 0;
    if (isActive !== undefined) plan.isActive = Boolean(isActive);
    if (trialDays !== undefined) plan.trialDays = Math.max(0, parseInt(trialDays, 10) || 0);
    if (maxSubscribers !== undefined) plan.maxSubscribers = maxSubscribers === null || maxSubscribers === '' ? null : Math.max(1, parseInt(maxSubscribers, 10));
    if (perks !== undefined) plan.perks = Array.isArray(perks) ? perks.slice(0, 10).map((p) => String(p).slice(0, 80)) : [];

    await plan.save();
    res.status(200).json({ success: true, data: plan });
  } catch (err) { next(err); }
};

// ── DELETE /subscription-plans/:id ────────────────────────────────────────
exports.deletePlan = async (req, res, next) => {
  try {
    const plan = await SubscriptionPlan.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!plan) return next(new AppError('Subscription plan not found.', 404));

    const activeSubs = await StoreSubscription.countDocuments({ planId: plan._id, status: { $in: ['active', 'paused'] } });
    if (activeSubs > 0) {
      return next(new AppError(`This plan has ${activeSubs} active subscriber(s) — deactivate it instead of deleting, so they keep receiving deliveries.`, 400));
    }

    await plan.deleteOne();
    res.status(200).json({ success: true, message: 'Subscription plan deleted.' });
  } catch (err) { next(err); }
};

// ── GET /subscription-plans/subscribers ───────────────────────────────────
exports.getSubscribers = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [subscribers, total, statusCounts, revenueAgg, cancelledThisMonth] = await Promise.all([
      StoreSubscription.find(filter).populate('planId', 'name interval').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      StoreSubscription.countDocuments(filter),
      StoreSubscription.aggregate([
        { $match: { companyId: req.companyId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      StoreSubscription.aggregate([
        { $match: { companyId: req.companyId, 'deliveryHistory.deliveryDate': { $gte: monthStart } } },
        { $unwind: '$deliveryHistory' },
        { $match: { 'deliveryHistory.deliveryDate': { $gte: monthStart }, 'deliveryHistory.status': 'created' } },
        { $group: { _id: null, revenue: { $sum: '$deliveryHistory.amount' } } },
      ]),
      StoreSubscription.countDocuments({ companyId: req.companyId, status: 'cancelled', cancelledAt: { $gte: monthStart } }),
    ]);

    const counts = Object.fromEntries(statusCounts.map((c) => [c._id, c.count]));
    const active = counts.active || 0;
    // Simple approximation: cancellations this month vs. the base that could
    // have cancelled (currently active + those who already left this month).
    const churnBase = active + cancelledThisMonth;
    const churnRate = churnBase > 0 ? Math.round((cancelledThisMonth / churnBase) * 1000) / 10 : 0;

    res.status(200).json({
      success: true,
      data: subscribers,
      stats: {
        total,
        active,
        paused: counts.paused || 0,
        cancelled: counts.cancelled || 0,
        expired: counts.expired || 0,
        revenueThisMonth: revenueAgg[0]?.revenue || 0,
        cancelledThisMonth,
        churnRate,
      },
      pagination: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) { next(err); }
};

// ── PATCH /store-subscriptions/:id/pause (owner-initiated) ────────────────
exports.pauseSubscriber = async (req, res, next) => {
  try {
    const sub = await StoreSubscription.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!sub) return next(new AppError('Subscription not found.', 404));
    if (sub.status !== 'active') return next(new AppError('Only an active subscription can be paused.', 400));

    sub.status = 'paused';
    sub.pausedAt = new Date();
    await sub.save();

    const company = await Company.findById(req.companyId).select('companyName logo');
    notifyCustomer(company, sub, 'paused', { by: 'store' }).catch((e) => logger.warn(`Subscription pause customer email failed: ${e.message}`));

    res.status(200).json({ success: true, data: sub });
  } catch (err) { next(err); }
};

// ── PATCH /store-subscriptions/:id/cancel (owner-initiated) ───────────────
exports.cancelSubscriber = async (req, res, next) => {
  try {
    const sub = await StoreSubscription.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!sub) return next(new AppError('Subscription not found.', 404));
    if (sub.status === 'cancelled') return next(new AppError('This subscription is already cancelled.', 400));

    sub.status = 'cancelled';
    sub.cancelledAt = new Date();
    sub.cancellationReason = req.body?.reason ? String(req.body.reason).slice(0, 300) : 'Cancelled by store';
    await sub.save();
    SubscriptionPlan.updateOne({ _id: sub.planId, subscriberCount: { $gt: 0 } }, { $inc: { subscriberCount: -1 } }).catch(() => {});

    const company = await Company.findById(req.companyId).select('companyName logo');
    notifyCustomer(company, sub, 'cancelled', { by: 'store' }).catch((e) => logger.warn(`Subscription cancel customer email failed: ${e.message}`));

    res.status(200).json({ success: true, data: sub });
  } catch (err) { next(err); }
};

// Shared with storeSubscriptionController's customer-initiated pause/cancel —
// exported so both sides send the identical email regardless of who acted.
async function notifyCustomer(company, sub, action, { by }) {
  const copy = {
    paused: { subject: `Your ${sub.name} subscription is paused`, line: `Your subscription has been paused${by === 'store' ? ` by ${company.companyName}` : ''}. No further deliveries or charges will happen until you resume it.` },
    cancelled: { subject: `Your ${sub.name} subscription was cancelled`, line: `Your subscription has been cancelled${by === 'store' ? ` by ${company.companyName}` : ''}. ${sub.cancellationReason ? `Reason: ${sub.cancellationReason}.` : ''}` },
    resumed: { subject: `Your ${sub.name} subscription is active again`, line: `Your subscription has been resumed. Your next delivery is scheduled for ${new Date(sub.nextDeliveryDate).toLocaleDateString()}.` },
  }[action];
  if (!copy || !sub.customerEmail) return;
  await emailService.send({
    to: sub.customerEmail,
    subject: copy.subject,
    html: emailService.baseTemplate(copy.subject, `
      <h2 style="color:#0f172a;margin:0 0 6px;">${copy.subject}</h2>
      <p style="color:#475569;font-size:14px;">${copy.line}</p>
    `, { name: company.companyName, logo: company.logo }),
  });
}
exports.notifyCustomer = notifyCustomer;
exports.resolvePlanItems = resolvePlanItems;
