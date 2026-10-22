'use strict';

// Enterprise is paid period by period (Paystack one-off checkout, priced by
// branch count), so nothing renews by itself. Remind the owner 7 days and
// 1 day before the paid period ends, with the price for their branches now.
const Company = require('../models/Company');
const User = require('../models/User');
const Branch = require('../models/Branch');
const emailService = require('../services/emailService');
const { enterpriseQuote } = require('./enterprisePricing');
const logger = require('./logger');

const DAY = 24 * 60 * 60 * 1000;
const APP_URL = (process.env.CLIENT_URL || 'http://localhost:5174').split(',')[0].replace(/\/$/, '');
const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;

async function runEnterpriseRenewalReminders() {
  try {
    const now = Date.now();
    const companies = await Company.find({
      'subscription.plan': 'enterprise',
      'subscription.status': 'active',
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
      const [owner, branches] = await Promise.all([
        User.findById(c.owner).select('name email'),
        Branch.countDocuments({ companyId: c._id, status: 'active' }),
      ]);
      if (!owner?.email) continue;
      const q = enterpriseQuote(branches);
      const cycle = c.subscription.billingCycle === 'annual' ? 'annual' : 'monthly';
      const price = cycle === 'annual' ? q.annual : q.monthly;
      const when = end.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#0f172a">
        <h2 style="margin:0 0 8px">Your Enterprise plan ends ${daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`}</h2>
        <p>Hi ${owner.name || 'there'}, ${c.companyName}'s Enterprise plan is paid up to <strong>${when}</strong>.</p>
        <p>Renewing for <strong>${branches} branch${branches === 1 ? '' : 'es'}</strong> costs <strong>${naira(price)}</strong> (${cycle}).
        Renewing early adds the new period on top of the days you have left.</p>
        <p>If it isn't renewed, Group Operations (branches, shift reports, approvals, inventory, credit and profit) locks 7 days after it ends. Your data is kept.</p>
        <p style="text-align:center;margin:24px 0"><a href="${APP_URL}/billing" style="background:#10b981;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Renew Enterprise</a></p>
      </div>`;
      // eslint-disable-next-line no-await-in-loop
      await emailService.sendEmail({ to: owner.email, subject: `Your Enterprise plan ends ${daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`}`, html })
        .catch((e) => logger.warn(`Enterprise renewal email failed for ${c._id}: ${e.message}`));
      logger.info(`Enterprise renewal reminder (${stage}d) sent to ${c.companyName}`);
    }
  } catch (err) {
    logger.error(`Enterprise renewal reminders failed: ${err.message}`);
  }
}

module.exports = { runEnterpriseRenewalReminders };
