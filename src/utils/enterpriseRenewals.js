'use strict';

// Plans that don't renew by themselves — Enterprise (a one-off Paystack
// checkout priced by branch count) and any plan paid by bank transfer — get
// a reminder 7 days and 1 day before the paid period ends, with the price
// to renew. Card subscriptions renew automatically and are skipped, and so
// is anyone who cancelled.
const Company = require('../models/Company');
const User = require('../models/User');
const Branch = require('../models/Branch');
const emailService = require('../services/emailService');
const { enterpriseQuote } = require('./enterprisePricing');
const logger = require('./logger');

const DAY = 24 * 60 * 60 * 1000;
const APP_URL = (process.env.CLIENT_URL || 'http://localhost:5174').split(',')[0].replace(/\/$/, '');
const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;

async function priceFor(c) {
  const cycle = c.subscription.billingCycle === 'annual' ? 'annual' : 'monthly';
  if (c.subscription.plan === 'enterprise') {
    const branches = await Branch.countDocuments({ companyId: c._id, status: 'active' });
    const q = enterpriseQuote(branches);
    return { cycle, price: cycle === 'annual' ? q.annual : q.monthly, detail: ` for <strong>${branches} branch${branches === 1 ? '' : 'es'}</strong>` };
  }
  const plan = require('../controllers/paymentController').PLANS[c.subscription.plan];
  return { cycle, price: cycle === 'annual' ? plan?.annualAmount : plan?.monthlyAmount, detail: '' };
}

async function runEnterpriseRenewalReminders() {
  try {
    const now = Date.now();
    const companies = await Company.find({
      'subscription.status': 'active',
      $or: [{ 'subscription.plan': 'enterprise' }, { 'subscription.paymentMethod': 'transfer', 'subscription.plan': { $ne: 'trial' } }],
      'subscription.currentPeriodEnd': { $gt: new Date(now), $lt: new Date(now + 7 * DAY + DAY) },
    }).select('companyName owner subscription');

    for (const c of companies) {
      const end = new Date(c.subscription.currentPeriodEnd);
      const daysLeft = Math.ceil((end - now) / DAY);
      const stage = daysLeft <= 1 ? '1' : daysLeft <= 7 ? '7' : null;
      if (!stage) continue;
      const tag = `${end.toISOString().slice(0, 10)}|${stage}`;
      if (c.subscription.renewalReminderFor === tag) continue;
      // Claim first so overlapping runs can't double-send.
      // eslint-disable-next-line no-await-in-loop
      const claimed = await Company.updateOne({ _id: c._id, 'subscription.renewalReminderFor': { $ne: tag } }, { $set: { 'subscription.renewalReminderFor': tag } });
      if (!claimed.modifiedCount) continue;

      // eslint-disable-next-line no-await-in-loop
      const [owner, { cycle, price, detail }] = await Promise.all([User.findById(c.owner).select('name email'), priceFor(c)]);
      if (!owner?.email) continue;
      const enterprise = c.subscription.plan === 'enterprise';
      const planName = enterprise ? 'Enterprise' : c.subscription.plan.charAt(0).toUpperCase() + c.subscription.plan.slice(1);
      const when = end.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const soon = daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#0f172a">
        <h2 style="margin:0 0 8px">Your ${planName} plan ends ${soon}</h2>
        <p>Hi ${owner.name || 'there'}, ${c.companyName}'s ${planName} plan is paid up to <strong>${when}</strong>.</p>
        <p>Renewing${detail} costs <strong>${naira(price)}</strong> (${cycle}). You can pay by bank transfer, USSD or card.
        Paying early adds the new period on top of the days you have left.</p>
        <p>${enterprise
          ? 'If it isn\'t renewed, Group Operations (branches, shift reports, approvals, inventory, credit and profit) locks 7 days after it ends.'
          : 'If it isn\'t renewed, your account locks 7 days after it ends.'} Your data is kept.</p>
        <p style="text-align:center;margin:24px 0"><a href="${APP_URL}/billing" style="background:#10b981;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Renew ${planName}</a></p>
        <p style="color:#64748b;font-size:13px">Don't want to continue? Cancel from Billing and these reminders stop.</p>
      </div>`;
      // eslint-disable-next-line no-await-in-loop
      await emailService.sendEmail({ to: owner.email, subject: `Your ${planName} plan ends ${soon}`, html })
        .catch((e) => logger.warn(`Renewal email failed for ${c._id}: ${e.message}`));
      logger.info(`Renewal reminder (${stage}d) sent to ${c.companyName}`);
    }
  } catch (err) {
    logger.error(`Renewal reminders failed: ${err.message}`);
  }
}

module.exports = { runEnterpriseRenewalReminders };
