'use strict';

const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

const PLANS = {
  starter: {
    name: 'Starter',
    monthlyAmount: 4900, // in kobo (₦4,900 × 100)
    annualAmount: 47000,
    currency: 'NGN',
    features: { maxUsers: 5, maxDocuments: 500, maxQuestionsPerMonth: 2000 },
    paystackMonthlyCode: process.env.PAYSTACK_STARTER_MONTHLY_CODE,
    paystackAnnualCode: process.env.PAYSTACK_STARTER_ANNUAL_CODE,
  },
  professional: {
    name: 'Professional',
    monthlyAmount: 14900,
    annualAmount: 143000,
    currency: 'NGN',
    features: { maxUsers: 25, maxDocuments: 2000, maxQuestionsPerMonth: 10000 },
    paystackMonthlyCode: process.env.PAYSTACK_PRO_MONTHLY_CODE,
    paystackAnnualCode: process.env.PAYSTACK_PRO_ANNUAL_CODE,
  },
  business: {
    name: 'Business',
    monthlyAmount: 34900,
    annualAmount: 335000,
    currency: 'NGN',
    features: { maxUsers: 100, maxDocuments: 10000, maxQuestionsPerMonth: 50000 },
    paystackMonthlyCode: process.env.PAYSTACK_BUSINESS_MONTHLY_CODE,
    paystackAnnualCode: process.env.PAYSTACK_BUSINESS_ANNUAL_CODE,
  },
};

// ── Helper: Paystack API call ─────────────────────────────────────────────
async function paystackAPI(method, endpoint, data) {
  if (!PAYSTACK_SECRET) throw new AppError('Payment service not configured.', 503);
  const res = await axios({
    method,
    url: `${PAYSTACK_BASE}${endpoint}`,
    data,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

// ── GET /plans ────────────────────────────────────────────────────────────
exports.getPlans = async (req, res) => {
  res.status(200).json({
    success: true,
    data: Object.entries(PLANS).map(([id, plan]) => ({
      id,
      name: plan.name,
      monthlyAmount: plan.monthlyAmount,
      annualAmount: plan.annualAmount,
      currency: plan.currency,
      monthlyDisplay: `₦${(plan.monthlyAmount).toLocaleString()}`,
      annualDisplay: `₦${(plan.annualAmount).toLocaleString()}`,
      savings: Math.round(((plan.monthlyAmount * 12 - plan.annualAmount) / (plan.monthlyAmount * 12)) * 100),
      features: plan.features,
    })),
  });
};

// ── POST /initialize ──────────────────────────────────────────────────────
exports.initializePayment = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly' } = req.body;
    if (!PLANS[plan]) return next(new AppError('Invalid plan selected.', 400));

    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    const selectedPlan = PLANS[plan];
    const amount = billingCycle === 'annual'
      ? selectedPlan.annualAmount
      : selectedPlan.monthlyAmount;

    const metadata = {
      companyId: req.companyId.toString(),
      userId: req.user._id.toString(),
      plan,
      billingCycle,
      companyName: company.companyName,
    };

    const response = await paystackAPI('POST', '/transaction/initialize', {
      email: req.user.email,
      amount: amount * 100, // Paystack uses kobo (smallest unit)
      currency: 'NGN',
      metadata,
      callback_url: `${process.env.CLIENT_URL?.split(',')[0]}/billing?payment=success`,
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
    });

    if (!response.status) throw new AppError('Payment initialization failed.', 500);

    logger.info(`Payment initialized for ${company.companyName}: ${plan} ${billingCycle}`);

    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: response.data.authorization_url,
        reference: response.data.reference,
        accessCode: response.data.access_code,
      },
    });
  } catch (err) {
    if (err.isOperational) return next(err);
    logger.error('Paystack init error:', err.message);
    next(new AppError('Payment service error. Please try again.', 500));
  }
};

// ── POST /verify/:reference ───────────────────────────────────────────────
exports.verifyPayment = async (req, res, next) => {
  try {
    const { reference } = req.params;
    const response = await paystackAPI('GET', `/transaction/verify/${reference}`);

    if (!response.status || response.data.status !== 'success') {
      return next(new AppError('Payment verification failed.', 400));
    }

    const { metadata, amount } = response.data;
    const { companyId, plan, billingCycle } = metadata;

    await upgradePlan(companyId, plan, billingCycle, reference, amount / 100);

    res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${PLANS[plan]?.name} plan.`,
      data: { plan, billingCycle },
    });
  } catch (err) {
    if (err.isOperational) return next(err);
    next(new AppError('Payment verification error.', 500));
  }
};

// ── POST /webhook ─────────────────────────────────────────────────────────
exports.webhook = async (req, res) => {
  try {
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      logger.warn('Invalid Paystack webhook signature');
      return res.status(400).json({ message: 'Invalid signature' });
    }

    const { event, data } = req.body;
    logger.info(`Paystack webhook: ${event}`);

    if (event === 'charge.success') {
      const { metadata, amount, reference } = data;
      if (metadata?.companyId && metadata?.plan) {
        await upgradePlan(
          metadata.companyId,
          metadata.plan,
          metadata.billingCycle || 'monthly',
          reference,
          amount / 100
        );
      }
    }

    if (event === 'subscription.disable') {
      const customerId = data.customer?.customer_code;
      if (customerId) {
        await Company.findOneAndUpdate(
          { 'subscription.paystackCustomerId': customerId },
          { 'subscription.status': 'inactive', 'subscription.plan': 'trial' }
        );
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Webhook error:', err.message);
    res.status(200).json({ received: true }); // Always return 200 to Paystack
  }
};

// ── GET /history ──────────────────────────────────────────────────────────
exports.getHistory = async (req, res, next) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(200).json({ success: true, data: [] });
    }
    const response = await paystackAPI('GET', `/transaction?perPage=20&customer=${req.user.email}`);
    const transactions = (response.data || []).map(t => ({
      reference: t.reference,
      amount: t.amount / 100,
      currency: t.currency,
      status: t.status,
      date: t.paid_at || t.created_at,
      channel: t.channel,
    }));
    res.status(200).json({ success: true, data: transactions });
  } catch (err) {
    res.status(200).json({ success: true, data: [] });
  }
};

// ── POST /cancel ──────────────────────────────────────────────────────────
exports.cancelSubscription = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    company.subscription.status = 'cancelled';
    await company.save();

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'subscription.cancel',
      description: `Cancelled ${company.subscription.plan} subscription`,
      ip: req.ip,
    });

    res.status(200).json({ success: true, message: 'Subscription cancelled. Access continues until period end.' });
  } catch (err) { next(err); }
};

// ── Internal: upgrade company plan ───────────────────────────────────────
async function upgradePlan(companyId, plan, billingCycle, reference, amount) {
  const planConfig = PLANS[plan];
  if (!planConfig) return;

  const now = new Date();
  const periodEnd = new Date(now);
  if (billingCycle === 'annual') {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  await Company.findByIdAndUpdate(companyId, {
    'subscription.plan': plan,
    'subscription.status': 'active',
    'subscription.currentPeriodStart': now,
    'subscription.currentPeriodEnd': periodEnd,
    'subscription.lastPaymentReference': reference,
    'subscription.lastPaymentAmount': amount,
    'limits.maxUsers': planConfig.features.maxUsers,
    'limits.maxDocuments': planConfig.features.maxDocuments,
    'limits.maxQuestionsPerMonth': planConfig.features.maxQuestionsPerMonth,
  });

  logger.info(`✅ Plan upgraded: company ${companyId} → ${plan} (${billingCycle})`);
}