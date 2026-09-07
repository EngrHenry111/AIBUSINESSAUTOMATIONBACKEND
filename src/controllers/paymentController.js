'use strict';

const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const Company = require('../models/Company');
const Payment = require('../models/Payment');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

// Paystack Plan codes (create the plans in dashboard.paystack.com → Plans)
const PAYSTACK_PLANS = {
  starter: {
    monthly: process.env.PAYSTACK_STARTER_MONTHLY_CODE,
    annual: process.env.PAYSTACK_STARTER_ANNUAL_CODE,
  },
  professional: {
    monthly: process.env.PAYSTACK_PRO_MONTHLY_CODE,
    annual: process.env.PAYSTACK_PRO_ANNUAL_CODE,
  },
  business: {
    monthly: process.env.PAYSTACK_BUSINESS_MONTHLY_CODE,
    annual: process.env.PAYSTACK_BUSINESS_ANNUAL_CODE,
  },
};

// plan_code -> { plan, billingCycle }
function planFromCode(code) {
  for (const [plan, cycles] of Object.entries(PAYSTACK_PLANS)) {
    for (const [billingCycle, c] of Object.entries(cycles)) {
      if (c && c === code) return { plan, billingCycle };
    }
  }
  return null;
}

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

// ── Helper: get or create a Paystack customer for a user ─────────────────
async function ensurePaystackCustomer(user) {
  try {
    const created = await paystackAPI('POST', '/customer', {
      email: user.email,
      first_name: (user.name || '').split(' ')[0] || undefined,
      last_name: (user.name || '').split(' ').slice(1).join(' ') || undefined,
    });
    return created.data?.customer_code || null;
  } catch (err) {
    // Customer already exists — fetch it
    try {
      const found = await paystackAPI('GET', `/customer/${encodeURIComponent(user.email)}`);
      return found.data?.customer_code || null;
    } catch {
      return null;
    }
  }
}

// ── Helper: resolve the Company for an incoming webhook customer ──────────
async function companyForWebhook(data) {
  const code = data.customer?.customer_code;
  const email = (data.customer?.email || '').toLowerCase();
  let company = null;
  if (code) {
    company = await Company.findOne({ 'subscription.paystackCustomerCode': code });
  }
  if (!company && data.subscription_code) {
    company = await Company.findOne({ 'subscription.paystackSubscriptionCode': data.subscription_code });
  }
  if (!company && email) {
    const user = await User.findOne({ email });
    if (user?.companyId) company = await Company.findById(user.companyId);
  }
  return company;
}

async function ownerEmail(company) {
  if (!company) return null;
  const owner = await User.findById(company.owner).select('name email');
  return owner ? { name: owner.name, email: owner.email } : null;
}

// ── POST /payments/subscribe — start a recurring subscription ────────────
exports.createSubscription = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly' } = req.body;
    const planConfig = PLANS[plan];
    const planCode = PAYSTACK_PLANS[plan]?.[billingCycle];

    if (!planConfig) return next(new AppError('Invalid plan selected.', 400));
    if (!planCode) {
      return next(new AppError(`Recurring billing for the ${plan} ${billingCycle} plan is not configured yet.`, 503));
    }

    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    const customerCode = await ensurePaystackCustomer(req.user);
    if (customerCode) {
      company.subscription.paystackCustomerCode = customerCode;
      await company.save();
    }

    // Initialising a transaction WITH a `plan` is how Paystack captures the
    // card and creates the subscription in one step. `POST /subscription`
    // alone needs a pre-existing authorization, which a new customer doesn't
    // have — so we send them to the checkout page to add a card.
    const amount = billingCycle === 'annual' ? planConfig.annualAmount : planConfig.monthlyAmount;
    const response = await paystackAPI('POST', '/transaction/initialize', {
      email: req.user.email,
      amount: amount * 100,
      plan: planCode,
      currency: 'NGN',
      metadata: {
        companyId: String(req.companyId),
        userId: String(req.user._id),
        plan,
        billingCycle,
        subscription: true,
      },
      callback_url: `${(process.env.CLIENT_URL || '').split(',')[0]}/billing?payment=success`,
      channels: ['card'],
    });

    if (!response.status) throw new AppError('Could not start the subscription.', 502);

    company.subscription.billingCycle = billingCycle;
    company.subscription.paystackPlanCode = planCode;
    await company.save();

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'subscription.create', description: `Started ${plan} ${billingCycle} subscription`, ip: req.ip,
    });

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
    logger.error('createSubscription error:', err.response?.data || err.message);
    next(new AppError('Payment service error. Please try again.', 502));
  }
};

// ── GET /payments/subscription — current subscription details ────────────
exports.getSubscriptionDetails = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('subscription');
    if (!company) return next(new AppError('Company not found.', 404));

    const sub = company.subscription || {};
    const base = {
      subscribed: Boolean(sub.paystackSubscriptionCode),
      plan: sub.plan || 'trial',
      status: sub.status || 'active',
      billingCycle: sub.billingCycle || 'monthly',
      currentPeriodEnd: sub.currentPeriodEnd || null,
    };

    if (!sub.paystackSubscriptionCode || !PAYSTACK_SECRET) {
      return res.status(200).json({ success: true, data: base });
    }

    try {
      const r = await paystackAPI('GET', `/subscription/${sub.paystackSubscriptionCode}`);
      const d = r.data || {};
      const auth = d.authorization || {};
      return res.status(200).json({
        success: true,
        data: {
          ...base,
          status: d.status || base.status,
          nextPaymentDate: d.next_payment_date || null,
          amount: d.amount ? d.amount / 100 : (base.billingCycle === 'annual'
            ? PLANS[base.plan]?.annualAmount : PLANS[base.plan]?.monthlyAmount) || null,
          currency: 'NGN',
          card: auth.last4 ? {
            last4: auth.last4,
            brand: auth.card_type || auth.brand || null,
            expMonth: auth.exp_month || null,
            expYear: auth.exp_year || null,
          } : null,
        },
      });
    } catch {
      return res.status(200).json({ success: true, data: base });
    }
  } catch (err) { next(err); }
};

// ── POST /webhook ─────────────────────────────────────────────────────────
exports.webhook = async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) return res.status(200).json({ received: true });

    // Verify against the RAW request body (app.js leaves this route unparsed)
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      logger.warn('Invalid Paystack webhook signature');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
    const { event, data } = payload;
    logger.info(`Paystack webhook: ${event}`);

    switch (event) {
      // First charge for a plan-based transaction, or any one-off charge
      case 'charge.success': {
        const { metadata, amount, reference } = data;
        if (metadata?.companyId && metadata?.plan) {
          await upgradePlan(metadata.companyId, metadata.plan, metadata.billingCycle || 'monthly', reference, amount / 100);
        }
        break;
      }

      // Subscription was created — persist its codes on the company
      case 'subscription.create': {
        const company = await companyForWebhook(data);
        const mapped = planFromCode(data.plan?.plan_code) || {};
        if (company) {
          company.subscription.paystackSubscriptionCode = data.subscription_code;
          company.subscription.paystackEmailToken = data.email_token;
          company.subscription.paystackCustomerCode = data.customer?.customer_code || company.subscription.paystackCustomerCode;
          company.subscription.paystackPlanCode = data.plan?.plan_code;
          if (mapped.plan) company.subscription.plan = mapped.plan;
          if (mapped.billingCycle) company.subscription.billingCycle = mapped.billingCycle;
          company.subscription.status = 'active';
          await company.save();
          logger.info(`Subscription ${data.subscription_code} linked to company ${company._id}`);
        }
        break;
      }

      // Subscription will not renew (card issue / cancellation) — warn the owner
      case 'subscription.not_renew': {
        const company = await companyForWebhook(data);
        const owner = await ownerEmail(company);
        if (owner) {
          const planName = PLANS[company.subscription.plan]?.name || company.subscription.plan;
          const end = company.subscription.currentPeriodEnd
            ? new Date(company.subscription.currentPeriodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
            : 'the end of your current period';
          emailService.sendSubscriptionWarning(owner.email, owner.name, planName, end)
            .catch((e) => logger.warn(`not_renew email failed: ${e.message}`));
        }
        break;
      }

      // Subscription disabled — company loses access
      case 'subscription.disable': {
        const company = await companyForWebhook(data);
        if (company) {
          company.subscription.status = 'expired';
          await company.save();
          logger.warn(`Subscription disabled for company ${company._id}`);
        }
        break;
      }

      // Recurring charge failed
      case 'invoice.payment_failed': {
        const company = await companyForWebhook(data);
        if (company) {
          company.subscription.status = 'past_due';
          await company.save();
          const owner = await ownerEmail(company);
          if (owner) {
            const planName = PLANS[company.subscription.plan]?.name || company.subscription.plan;
            const amt = data.amount ? `NGN ${(data.amount / 100).toLocaleString()}` : 'your subscription fee';
            emailService.sendPaymentFailed(owner.email, owner.name, planName, amt)
              .catch((e) => logger.warn(`payment_failed email failed: ${e.message}`));
          }
        }
        break;
      }

      // Recurring charge succeeded — extend the period by 30 days
      case 'invoice.update':
      case 'invoice.payment_success': {
        const paidOk = data.status === 'success' || data.paid === true || event === 'invoice.payment_success';
        if (!paidOk) break;
        const company = await companyForWebhook(data);
        if (company) {
          const from = company.subscription.currentPeriodEnd && new Date(company.subscription.currentPeriodEnd) > new Date()
            ? new Date(company.subscription.currentPeriodEnd)
            : new Date();
          const extended = new Date(from);
          extended.setDate(extended.getDate() + 30);

          company.subscription.status = 'active';
          company.subscription.currentPeriodStart = company.subscription.currentPeriodStart || new Date();
          company.subscription.currentPeriodEnd = extended;
          await company.save();

          const amount = (data.amount || data.transaction?.amount || 0) / 100;
          const reference = data.transaction?.reference || data.reference || `inv_${data.invoice_code || Date.now()}`;
          if (amount > 0) {
            try {
              await Payment.findOneAndUpdate(
                { reference },
                {
                  companyId: company._id,
                  plan: company.subscription.plan,
                  billingCycle: company.subscription.billingCycle || 'monthly',
                  amount, currency: 'NGN', status: 'success', paidAt: new Date(),
                },
                { upsert: true, setDefaultsOnInsert: true }
              );
            } catch (e) { logger.error(`recurring payment record failed: ${e.message}`); }
          }
          logger.info(`Subscription renewed for company ${company._id} → ${extended.toISOString()}`);
        }
        break;
      }

      default:
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Webhook error:', err.message);
    res.status(200).json({ received: true }); // Always 200 so Paystack doesn't hammer us
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

// ── POST /cancel-subscription (and /cancel) ─────────────────────────────
exports.cancelSubscription = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    const code = company.subscription?.paystackSubscriptionCode;
    if (code && PAYSTACK_SECRET) {
      try {
        let token = company.subscription.paystackEmailToken;
        if (!token) {
          const info = await paystackAPI('GET', `/subscription/${code}`);
          token = info.data?.email_token;
          if (token) {
            company.subscription.paystackEmailToken = token;
          }
        }
        if (token) {
          await paystackAPI('POST', '/subscription/disable', { code, token });
        }
      } catch (err) {
        logger.warn(`Paystack disable failed for ${code}: ${err.response?.data?.message || err.message}`);
        // fall through — we still mark it cancelled locally
      }
    }

    company.subscription.status = 'cancelled';
    await company.save();

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'subscription.cancel',
      description: `Cancelled ${company.subscription.plan} subscription`,
      ip: req.ip,
    });

    res.status(200).json({
      success: true,
      message: 'Subscription cancelled. You keep access until the end of the current billing period.',
      data: { currentPeriodEnd: company.subscription.currentPeriodEnd || null },
    });
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

  // Record the transaction for revenue reporting. Keyed on reference so the
  // verify call and the webhook for the same charge don't create duplicates.
  try {
    await Payment.findOneAndUpdate(
      { reference },
      {
        companyId,
        plan,
        billingCycle,
        amount,
        currency: planConfig.currency || 'NGN',
        status: 'success',
        paidAt: now,
      },
      { upsert: true, setDefaultsOnInsert: true, new: true }
    );
  } catch (err) {
    logger.error(`Failed to record payment ${reference}: ${err.message}`);
  }

  logger.info(`✅ Plan upgraded: company ${companyId} → ${plan} (${billingCycle})`);
}