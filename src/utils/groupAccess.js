'use strict';

// Who may use Group Operations (branches, command center, shift sheets,
// inventory, credit, profit…): companies on the Enterprise plan, plus free
// trials so they can see the value before paying. An Enterprise plan that
// lapsed past its grace period (subscriptionChecker marks it 'expired') loses
// access until renewed. Super admins always pass.
const { AppError } = require('../middleware/errorMiddleware');

const GROUP_PLANS = ['enterprise', 'trial'];

function groupAccessFor(company, user) {
  if (user?.role === 'super_admin') return { allowed: true, reason: null };
  const plan = company?.subscription?.plan || 'trial';
  const status = company?.subscription?.status || 'active';
  if (plan === 'trial') return { allowed: true, reason: null, trial: true };
  if (plan === 'enterprise') {
    if (status === 'expired' || status === 'inactive') return { allowed: false, reason: 'expired' };
    return { allowed: true, reason: null };
  }
  return { allowed: false, reason: 'upgrade' };
}

// Mongo filter for companies whose background group jobs should still run.
const GROUP_ELIGIBLE_FILTER = {
  $or: [
    { 'subscription.plan': 'trial' },
    { 'subscription.plan': { $exists: false } },
    { 'subscription.plan': 'enterprise', 'subscription.status': { $nin: ['expired', 'inactive'] } },
  ],
};

const requireGroupPlan = (req, res, next) => {
  const access = groupAccessFor(req.company, req.user);
  if (access.allowed) return next();
  const err = new AppError(
    access.reason === 'expired'
      ? 'Your Enterprise plan has expired. Renew it on the Billing page to keep using Group Operations.'
      : 'Group Operations is part of the Enterprise plan. Upgrade on the Billing page to manage multiple branches.',
    402,
  );
  err.code = 'ENTERPRISE_REQUIRED';
  return next(err);
};

module.exports = { groupAccessFor, requireGroupPlan, GROUP_ELIGIBLE_FILTER, GROUP_PLANS };
