'use strict';

// Customer-facing half of Store Subscriptions — browsing plans, subscribing,
// and self-service pause/resume/cancel. The owner-facing half (creating
// plans, viewing subscribers) lives in subscriptionPlanController.js. The
// daily recurring-delivery cron lives in utils/storeSubscriptionProcessor.js
// and calls createSubscriptionOrder() exported from here.
const SubscriptionPlan = require('../models/SubscriptionPlan');
const StoreSubscription = require('../models/StoreSubscription');
const Company = require('../models/Company');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { paystackAPI } = require('../utils/paystack');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const { notifyCustomer } = require('./subscriptionPlanController');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// findStore/finalizePlacedOrder/nextOrderNumber live in storefrontController —
// required lazily to avoid a require cycle at module load (same pattern
// giftCardController already uses for findStore).
function sc() { return require('./storefrontController'); }

function calculateNextDate(interval, from = new Date()) {
  const next = new Date(from);
  switch (interval) {
    case 'daily': next.setDate(next.getDate() + 1); break;
    case 'weekly': next.setDate(next.getDate() + 7); break;
    case 'biweekly': next.setDate(next.getDate() + 14); break;
    case 'monthly': next.setMonth(next.getMonth() + 1); break;
    case 'quarterly': next.setMonth(next.getMonth() + 3); break;
    default: next.setMonth(next.getMonth() + 1);
  }
  return next;
}
exports.calculateNextDate = calculateNextDate;

const publicPlan = (p) => ({
  _id: p._id,
  name: p.name,
  description: p.description,
  image: p.image || null,
  items: (p.items || []).map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })),
  interval: p.interval,
  price: p.price,
  originalPrice: p.originalPrice || null,
  deliveryFee: p.deliveryFee || 0,
  subscriberCount: p.subscriberCount || 0,
  trialDays: p.trialDays || 0,
  perks: p.perks || [],
  soldOut: Boolean(p.maxSubscribers) && p.subscriberCount >= p.maxSubscribers,
});

const publicSubscription = (s) => ({
  _id: s._id,
  name: s.name,
  interval: s.interval,
  items: s.items,
  total: s.total,
  currency: s.currency || 'NGN',
  status: s.status,
  paymentMethod: s.paymentMethod,
  startDate: s.startDate,
  nextDeliveryDate: s.nextDeliveryDate,
  lastDeliveryDate: s.lastDeliveryDate || null,
  totalDeliveries: s.totalDeliveries || 0,
  deliveryHistory: (s.deliveryHistory || []).slice(-20).reverse(),
  pausedAt: s.pausedAt || null,
  cancelledAt: s.cancelledAt || null,
});

// ── GET /store/:slug/subscription-plans (public) ───────────────────────────
exports.getPublicPlans = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug);
    const plans = await SubscriptionPlan.find({ companyId: company._id, isActive: true }).sort({ price: 1 });
    res.status(200).json({ success: true, data: plans.map(publicPlan) });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/subscribe (store-customer auth) ──────────────────────
// Subscribing requires a store account — a recurring subscription needs
// somewhere for pause/resume/cancel and delivery history to live (the same
// reason "My Subscriptions" is auth-gated), unlike a one-off guest checkout.
exports.subscribe = async (req, res, next) => {
  try {
    const { planId, paymentMethod = 'paystack', startDate, customerDetails = {} } = req.body;
    const company = await sc().findStore(req.params.slug, { requirePayments: paymentMethod === 'paystack' });

    const plan = await SubscriptionPlan.findOne({ _id: planId, companyId: company._id, isActive: true });
    if (!plan) return next(new AppError('Subscription plan not found.', 404));
    if (plan.maxSubscribers && plan.subscriberCount >= plan.maxSubscribers) {
      return next(new AppError('This plan is full — it is not accepting new subscribers right now.', 400));
    }
    if (!['paystack', 'pay_on_delivery'].includes(paymentMethod)) return next(new AppError('Invalid payment method.', 400));
    if (paymentMethod === 'pay_on_delivery' && !company.deliverySettings?.podEnabled) {
      return next(new AppError('Pay on delivery is not available for this store.', 400));
    }

    const existing = await StoreSubscription.findOne({ companyId: company._id, customerId: req.storeCustomer._id, planId: plan._id, status: { $in: ['active', 'paused'] } });
    if (existing) return next(new AppError('You already have a subscription to this plan.', 400));

    const chosenStart = startDate ? new Date(startDate) : new Date();
    if (Number.isNaN(chosenStart.getTime()) || chosenStart < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      return next(new AppError('Please choose a valid start date (today or later).', 400));
    }

    const items = plan.items.map((i) => ({
      productId: i.productId, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, total: i.quantity * i.unitPrice,
    }));
    const subtotal = items.reduce((sum, i) => sum + i.total, 0);
    const total = Math.round((plan.price + (plan.deliveryFee || 0)) * 100) / 100;

    const customer = {
      customerName: customerDetails.name || req.storeCustomer.name,
      customerPhone: customerDetails.phone || req.storeCustomer.phone,
      customerAddress: customerDetails.address,
    };

    // ── Pay on Delivery — no charge now. First delivery (and every one
    // after) is created by the daily processor once nextDeliveryDate is due.
    if (paymentMethod === 'pay_on_delivery') {
      const nextDeliveryDate = new Date(chosenStart);
      nextDeliveryDate.setDate(nextDeliveryDate.getDate() + (plan.trialDays || 0));

      const sub = await StoreSubscription.create({
        companyId: company._id, planId: plan._id, customerId: req.storeCustomer._id,
        customerEmail: req.storeCustomer.email, ...customer,
        name: plan.name, description: plan.description, items, subtotal, deliveryFee: plan.deliveryFee || 0,
        total, currency: 'NGN', interval: plan.interval, status: 'active', paymentMethod: 'pay_on_delivery',
        startDate: chosenStart, nextDeliveryDate,
      });
      await afterSubscribed(company, plan, sub);
      return res.status(201).json({ success: true, data: { subscription: publicSubscription(sub), directSubscribe: true } });
    }

    // ── Paystack — a real charge for the first delivery is unavoidable here:
    // Paystack has no zero-value card-verification primitive, and the
    // authorization_code needed for every later renewal only comes back on a
    // successful charge. So "trial days" for a card-based plan defers the
    // SECOND charge rather than waiving the first (see verifySubscription).
    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email: req.storeCustomer.email,
      amount: Math.round(total * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card'], // recurring renewal only works with a tokenized card
      metadata: {
        type: 'store_subscription_signup',
        companyId: String(company._id),
        slug: company.storeSlug,
        planId: String(plan._id),
        customerId: String(req.storeCustomer._id),
        startDate: chosenStart.toISOString(),
        ...customer,
      },
      callback_url: `${clientUrl()}/store/${company.storeSlug}/subscribe/${plan._id}?ref={reference}`,
    });
    if (!initRes.status) throw new AppError('Could not start checkout. Please try again.', 502);

    res.status(200).json({ success: true, data: { authorizationUrl: initRes.data.authorization_url, reference: initRes.data.reference, total } });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/subscribe/verify/:reference (store-customer auth) ────
// Not in the original spec's route list, but required — Paystack redirects
// the customer back after checkout, and this is what turns that completed
// payment into the actual StoreSubscription (same purpose as gift cards'
// verifyGiftCardPurchase). Idempotent on paystackReference via
// deliveryHistory lookup below, same as fulfilStorefrontOrder.
exports.verifySubscription = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug);
    const { reference } = req.params;

    // paystackReference lives on the Order the signup produced, not on the
    // subscription itself — check via the Order for idempotency, same as
    // fulfilStorefrontOrder does for regular checkout.
    const Order = require('../models/Order');
    const existingOrder = await Order.findOne({ paystackReference: reference, companyId: company._id });
    if (existingOrder) {
      const sub = await StoreSubscription.findOne({ companyId: company._id, 'deliveryHistory.orderId': existingOrder._id });
      if (sub) return res.status(200).json({ success: true, data: { subscription: publicSubscription(sub) } });
    }

    const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!vr.status || vr.data?.status !== 'success') return next(new AppError('Payment has not been completed.', 400));
    const meta = vr.data.metadata || {};
    if (String(meta.companyId) !== String(company._id) || meta.type !== 'store_subscription_signup') {
      return next(new AppError('This payment does not belong to this store.', 400));
    }

    const plan = await SubscriptionPlan.findOne({ _id: meta.planId, companyId: company._id });
    if (!plan) return next(new AppError('Subscription plan no longer exists.', 404));

    const startDate = meta.startDate ? new Date(meta.startDate) : new Date();
    const items = plan.items.map((i) => ({
      productId: i.productId, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, total: i.quantity * i.unitPrice,
    }));
    const subtotal = items.reduce((sum, i) => sum + i.total, 0);
    const total = (vr.data.amount || 0) / 100;
    const authorizationCode = vr.data.authorization?.authorization_code;
    if (!authorizationCode || vr.data.authorization?.reusable === false) {
      return next(new AppError('This card cannot be saved for recurring billing. Please use a different card.', 400));
    }

    const now = new Date();
    const nextDeliveryDate = calculateNextDate(plan.interval, now);
    if (plan.trialDays > 0) nextDeliveryDate.setDate(nextDeliveryDate.getDate() + plan.trialDays);

    const sub = await StoreSubscription.create({
      companyId: company._id, planId: plan._id, customerId: meta.customerId,
      customerEmail: vr.data.customer?.email, customerName: meta.customerName, customerPhone: meta.customerPhone, customerAddress: meta.customerAddress,
      name: plan.name, description: plan.description, items, subtotal, deliveryFee: plan.deliveryFee || 0,
      total, currency: 'NGN', interval: plan.interval, status: 'active', paymentMethod: 'paystack',
      paystackAuthorizationCode: authorizationCode,
      startDate, nextDeliveryDate, lastDeliveryDate: now, totalDeliveries: 1,
    });

    // First delivery — paid for by the charge that just verified — is
    // created immediately rather than waiting for tomorrow's cron.
    const order = await createOrderForDelivery(company, sub, { paystackReference: reference, paymentStatus: 'paid', status: 'confirmed' });
    sub.deliveryHistory.push({ orderId: order._id, deliveryDate: now, status: 'created', amount: total });
    await sub.save();

    await afterSubscribed(company, plan, sub);
    res.status(201).json({ success: true, data: { subscription: publicSubscription(sub) } });
  } catch (err) { next(err); }
};

async function afterSubscribed(company, plan, sub) {
  SubscriptionPlan.updateOne({ _id: plan._id }, { $inc: { subscriberCount: 1 } }).catch(() => {});

  emailService.send({
    to: sub.customerEmail,
    subject: `You're subscribed to ${sub.name}! 🎉`,
    html: emailService.baseTemplate('Subscription confirmed', `
      <h2 style="color:#0f172a;margin:0 0 6px;">You're subscribed! 🎉</h2>
      <p style="color:#475569;font-size:14px;">Your <strong>${sub.name}</strong> subscription (${naira(sub.total)} / ${sub.interval}) is now active.</p>
      <p style="color:#475569;font-size:14px;">Your first delivery: <strong>${new Date(sub.nextDeliveryDate <= new Date() ? sub.lastDeliveryDate || sub.startDate : sub.nextDeliveryDate).toLocaleDateString()}</strong>. We'll notify you before each delivery.</p>
    `, { name: company.companyName, logo: company.logo }),
  }).catch((e) => logger.warn(`Subscription welcome email failed: ${e.message}`));

  User.findById(company.owner).select('email').then((owner) => {
    if (!owner?.email) return;
    emailService.send({
      to: owner.email,
      subject: `New subscriber — ${sub.name}`,
      html: emailService.baseTemplate('New subscriber', `
        <h2 style="color:#0f172a;margin:0 0 6px;">New subscriber 📦</h2>
        <p style="color:#475569;font-size:14px;">${sub.customerName || sub.customerEmail} just subscribed to <strong>${sub.name}</strong> (${naira(sub.total)} / ${sub.interval}).</p>
      `, { name: company.companyName, logo: company.logo }),
    }).catch(() => {});
  }).catch(() => {});
}

// ── GET /store/:slug/my-subscriptions (store-customer auth) ───────────────
exports.getMySubscriptions = async (req, res, next) => {
  try {
    const subs = await StoreSubscription.find({ companyId: req.store._id, customerId: req.storeCustomer._id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: subs.map(publicSubscription) });
  } catch (err) { next(err); }
};

// ── PATCH /store/:slug/subscriptions/:id/pause (store-customer auth) ──────
exports.pauseMySubscription = async (req, res, next) => {
  try {
    const sub = await StoreSubscription.findOne({ _id: req.params.id, companyId: req.store._id, customerId: req.storeCustomer._id });
    if (!sub) return next(new AppError('Subscription not found.', 404));
    if (sub.status !== 'active') return next(new AppError('Only an active subscription can be paused.', 400));

    sub.status = 'paused';
    sub.pausedAt = new Date();
    await sub.save();
    notifyOwner(req.store, sub, 'paused').catch(() => {});

    res.status(200).json({ success: true, data: publicSubscription(sub) });
  } catch (err) { next(err); }
};

// ── PATCH /store/:slug/subscriptions/:id/resume (store-customer auth) ─────
// Not explicitly listed among the spec's routes, but required — the spec's
// own notes describe pausing for a holiday and "resume when ready", and a
// pause with no way back would make that permanent.
exports.resumeMySubscription = async (req, res, next) => {
  try {
    const sub = await StoreSubscription.findOne({ _id: req.params.id, companyId: req.store._id, customerId: req.storeCustomer._id });
    if (!sub) return next(new AppError('Subscription not found.', 404));
    if (sub.status !== 'paused') return next(new AppError('Only a paused subscription can be resumed.', 400));

    sub.status = 'active';
    sub.pausedAt = undefined;
    // If the original next-delivery date already passed while paused, pull
    // it up to today so tomorrow's processor run picks it up immediately
    // rather than treating a stale past date as "overdue by weeks".
    if (sub.nextDeliveryDate < new Date()) sub.nextDeliveryDate = new Date();
    await sub.save();
    notifyCustomer(req.store, sub, 'resumed', { by: 'customer' }).catch(() => {});

    res.status(200).json({ success: true, data: publicSubscription(sub) });
  } catch (err) { next(err); }
};

// ── PATCH /store/:slug/subscriptions/:id/cancel (store-customer auth) ─────
exports.cancelMySubscription = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return next(new AppError('A cancellation reason is required.', 400));

    const sub = await StoreSubscription.findOne({ _id: req.params.id, companyId: req.store._id, customerId: req.storeCustomer._id });
    if (!sub) return next(new AppError('Subscription not found.', 404));
    if (sub.status === 'cancelled') return next(new AppError('This subscription is already cancelled.', 400));

    sub.status = 'cancelled';
    sub.cancelledAt = new Date();
    sub.cancellationReason = String(reason).slice(0, 300);
    await sub.save();
    SubscriptionPlan.updateOne({ _id: sub.planId, subscriberCount: { $gt: 0 } }, { $inc: { subscriberCount: -1 } }).catch(() => {});
    notifyOwner(req.store, sub, 'cancelled').catch(() => {});

    res.status(200).json({ success: true, data: publicSubscription(sub) });
  } catch (err) { next(err); }
};

async function notifyOwner(company, sub, action) {
  const owner = await User.findById(company.owner).select('email');
  if (!owner?.email) return;
  const verb = action === 'paused' ? 'paused' : 'cancelled';
  await emailService.send({
    to: owner.email,
    subject: `A subscriber ${verb} — ${sub.name}`,
    html: emailService.baseTemplate('Subscriber update', `
      <h2 style="color:#0f172a;margin:0 0 6px;">Subscriber ${verb} their plan</h2>
      <p style="color:#475569;font-size:14px;">${sub.customerName || sub.customerEmail} ${verb} their <strong>${sub.name}</strong> subscription.${sub.cancellationReason ? ` Reason: ${sub.cancellationReason}.` : ''}</p>
    `, { name: company.companyName, logo: company.logo }),
  });
}

// ── Shared order-creation for a subscription delivery ──────────────────────
// Mirrors createDirectOrder/fulfilStorefrontOrder's shape so this order
// behaves identically everywhere else in the app (Orders page, analytics,
// stock deduction via finalizePlacedOrder).
async function createOrderForDelivery(company, sub, { paystackReference, paymentStatus, status } = {}) {
  const Order = require('../models/Order');
  const orderNumber = await sc().nextOrderNumber(company._id);
  const order = await Order.create({
    companyId: company._id,
    orderNumber,
    source: 'storefront',
    paystackReference,
    customer: { name: sub.customerName, email: sub.customerEmail, phone: sub.customerPhone, address: sub.customerAddress },
    items: sub.items.map((i) => ({ productId: i.productId, name: i.name, image: i.image, quantity: i.quantity, price: i.unitPrice })),
    subtotal: sub.subtotal,
    deliveryFee: sub.deliveryFee,
    total: sub.total,
    currency: 'NGN',
    paymentMethod: sub.paymentMethod,
    status: status || (sub.paymentMethod === 'paystack' ? 'confirmed' : 'pending'),
    paymentStatus: paymentStatus || (sub.paymentMethod === 'paystack' ? 'paid' : 'unpaid'),
    notes: `Subscription delivery — ${sub.name}`,
    stockApplied: false,
    timeline: [{
      status: status || 'pending',
      description: `Subscription delivery — ${sub.name} (${sub.interval})`,
      timestamp: new Date(),
    }],
  });
  await sc().finalizePlacedOrder(company, order, { io: global.io });
  return order;
}
exports.createOrderForDelivery = createOrderForDelivery;

// ── Called by the daily processor for every subscription whose
// nextDeliveryDate is due. Charges the saved card (paystack) or creates an
// unpaid order (pay_on_delivery), then advances the schedule. ─────────────
async function createSubscriptionOrder(sub) {
  const company = await Company.findById(sub.companyId);
  if (!company) throw new Error('Company not found for subscription');

  if (sub.paymentMethod === 'pay_on_delivery') {
    const order = await createOrderForDelivery(company, sub, { status: 'pending', paymentStatus: 'unpaid' });
    return { order, charged: false };
  }

  // paystack — charge the saved authorization for this cycle's amount
  const chargeRes = await paystackAPI('POST', '/transaction/charge_authorization', {
    authorization_code: sub.paystackAuthorizationCode,
    email: sub.customerEmail,
    amount: Math.round(sub.total * 100),
    currency: 'NGN',
    subaccount: company.paymentSettings?.paystackSubaccountCode,
    bearer: 'subaccount',
  }).catch((err) => ({ status: false, message: err.message }));

  if (!chargeRes.status || chargeRes.data?.status !== 'success') {
    const err = new Error(chargeRes.data?.gateway_response || chargeRes.message || 'Charge failed');
    err.chargeFailed = true;
    throw err;
  }

  const order = await createOrderForDelivery(company, sub, {
    paystackReference: chargeRes.data.reference, status: 'confirmed', paymentStatus: 'paid',
  });
  return { order, charged: true };
}
exports.createSubscriptionOrder = createSubscriptionOrder;
