'use strict';

const Company = require('../models/Company');
const logger = require('./logger');

// Free trial: every feature, for 14 days from the day the account opened.
// Accounts that signed up before the trial had an end date (when it ran
// forever) get until TRIAL_NOTICE_UNTIL instead of being locked out the day
// this shipped. subscription.trialEndsAt, when set (e.g. by an admin
// extending a trial), wins over both.
const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_LIMITS_STARTED = new Date('2026-11-05T00:00:00+01:00');
const TRIAL_NOTICE_UNTIL = new Date('2026-11-12T00:00:00+01:00');

function trialEndsAt(company) {
  if (!company) return null;
  if (company.subscription?.trialEndsAt) return new Date(company.subscription.trialEndsAt);
  const opened = new Date(company.createdAt || Date.now());
  const end = new Date(opened.getTime() + TRIAL_DAYS * DAY_MS);
  if (opened < TRIAL_LIMITS_STARTED && end < TRIAL_NOTICE_UNTIL) return new Date(TRIAL_NOTICE_UNTIL);
  return end;
}

const isTrial = (company) => (company?.subscription?.plan || 'trial') === 'trial';

// On the trial and it hasn't run out: everything is unlocked.
function isTrialActive(company) {
  return isTrial(company) && Date.now() < trialEndsAt(company).getTime();
}

function trialDaysLeft(company) {
  if (!isTrialActive(company)) return 0;
  return Math.ceil((trialEndsAt(company).getTime() - Date.now()) / DAY_MS);
}

// Features sold on the Business plan (e-Procurement) are open during the trial.
const hasBusinessFeatures = (company) => company?.subscription?.plan === 'business' || isTrialActive(company);

// Team seats: the trial gets the Business plan's allowance.
const TRIAL_MAX_USERS = 100;
function seatLimit(company) {
  const own = company?.limits?.maxUsers;
  if (isTrialActive(company)) return own > 0 ? Math.max(own, TRIAL_MAX_USERS) : (own ?? TRIAL_MAX_USERS);
  return own;
}

/**
 * Runs daily — checks all companies for expired subscriptions
 * Grace period: 7 days after expiry before soft-blocking
 */
async function checkSubscriptions() {
  try {
    const now = new Date();
    const gracePeriodEnd = new Date(now);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() - 7); // 7 days ago

    // Find companies where subscription ended more than 7 days ago
    // and are still marked active (not already suspended)
    const expired = await Company.find({
      'subscription.plan': { $ne: 'trial' }, // trial never expires
      'subscription.status': 'active',
      'subscription.currentPeriodEnd': { $lt: gracePeriodEnd },
    });

    if (expired.length === 0) {
      logger.info('Subscription check: all subscriptions current ✅');
      return;
    }

    for (const company of expired) {
      await Company.findByIdAndUpdate(company._id, {
        'subscription.status': 'expired',
      });
      logger.warn(`⚠️  Subscription expired: ${company.companyName} (plan: ${company.subscription.plan}, ended: ${company.subscription.currentPeriodEnd})`);
    }

    logger.info(`Subscription check complete: ${expired.length} company(ies) marked expired`);
  } catch (err) {
    logger.error('Subscription checker error:', err.message);
  }
}

/**
 * Returns subscription state for a company:
 * - 'active'       → full access
 * - 'grace'        → within 7-day grace period, show warning banner
 * - 'expired'      → soft block, redirect to billing
 * - 'trial'        → full access, until the 14-day trial ends ('expired' after)
 * - 'suspended'    → manually suspended by admin
 */
function getSubscriptionState(company) {
  if (!company) return 'expired';

  const plan = company.subscription?.plan;
  const status = company.subscription?.status;
  const periodEnd = company.subscription?.currentPeriodEnd;

  if (!plan || plan === 'trial') return isTrialActive(company) ? 'trial' : 'expired';

  // Manually suspended by admin
  if (status === 'suspended') return 'suspended';

  // Already marked expired
  if (status === 'expired') return 'expired';

  // No period end set — active
  if (!periodEnd) return 'active';

  const now = new Date();
  const end = new Date(periodEnd);
  const diffDays = Math.floor((now - end) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return 'active';           // Not expired yet
  if (diffDays <= 7) return 'grace';            // Within grace period
  return 'expired';                              // Past grace period
}

/**
 * How many grace days remain (0-7)
 */
function graceRemainingDays(company) {
  const periodEnd = company?.subscription?.currentPeriodEnd;
  if (!periodEnd) return 0;
  const now = new Date();
  const end = new Date(periodEnd);
  const diffDays = Math.floor((now - end) / (1000 * 60 * 60 * 24));
  return Math.max(0, 7 - diffDays);
}

// Everything the app needs about access, sent with every login and /auth/me.
function subscriptionInfo(company, user) {
  if (user?.role === 'super_admin') return { subscriptionState: 'active', graceDays: null };
  const subscriptionState = getSubscriptionState(company);
  return {
    subscriptionState,
    graceDays: subscriptionState === 'grace' ? graceRemainingDays(company) : null,
    ...(company && isTrial(company) && { trialEndsAt: trialEndsAt(company), trialDaysLeft: trialDaysLeft(company) }),
  };
}

module.exports = {
  checkSubscriptions, getSubscriptionState, graceRemainingDays, subscriptionInfo,
  trialEndsAt, isTrialActive, trialDaysLeft, hasBusinessFeatures, seatLimit, TRIAL_DAYS,
};
