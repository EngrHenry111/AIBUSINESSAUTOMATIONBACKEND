'use strict';

const Company = require('../models/Company');
const logger = require('./logger');

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
 * - 'trial'        → full access (trial plan)
 * - 'suspended'    → manually suspended by admin
 */
function getSubscriptionState(company) {
  if (!company) return 'expired';

  const plan = company.subscription?.plan;
  const status = company.subscription?.status;
  const periodEnd = company.subscription?.currentPeriodEnd;

  // Trial never expires
  if (plan === 'trial') return 'trial';

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

module.exports = { checkSubscriptions, getSubscriptionState, graceRemainingDays };
