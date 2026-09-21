'use strict';

const LoyaltyProgram = require('../models/LoyaltyProgram');
const CustomerPoints = require('../models/CustomerPoints');
const Customer = require('../models/Customer');
const logger = require('./logger');

const DEFAULT_TIERS = [
  { name: 'Bronze', minimumPoints: 0, benefits: 'Welcome perks and birthday rewards', badgeColor: '#cd7f32', discountPercent: 0 },
  { name: 'Silver', minimumPoints: 500, benefits: 'Early access to sales and promos', badgeColor: '#c0c0c0', discountPercent: 2 },
  { name: 'Gold', minimumPoints: 2000, benefits: 'Priority support and bigger discounts', badgeColor: '#ffd700', discountPercent: 5 },
  { name: 'Platinum', minimumPoints: 5000, benefits: 'VIP treatment and exclusive offers', badgeColor: '#e5e4e2', discountPercent: 10 },
];

function resolveTier(points, tiers) {
  const list = tiers?.length ? tiers : DEFAULT_TIERS;
  const sorted = [...list].sort((a, b) => b.minimumPoints - a.minimumPoints);
  return (sorted.find((t) => points >= t.minimumPoints) || sorted[sorted.length - 1])?.name || 'Bronze';
}

// Loyalty is tracked by email — orders/invoices only ever carry an embedded
// customer snapshot, never a guaranteed Customer document reference, so email
// is the one identity signal reliably present everywhere points are earned.
async function findOrCreatePoints(companyId, customer) {
  const email = (customer?.email || '').trim().toLowerCase();
  if (!email) return null;
  const name = (customer?.name || '').trim() || email;

  let record = await CustomerPoints.findOne({ companyId, customerEmail: email });
  if (record) {
    if (!record.customerId) {
      const linked = await Customer.findOne({ companyId, email }).select('_id');
      if (linked) { record.customerId = linked._id; await record.save(); }
    }
    return record;
  }

  const linked = await Customer.findOne({ companyId, email }).select('_id');
  try {
    return await CustomerPoints.create({
      companyId, customerId: linked?._id, customerEmail: email, customerName: name,
    });
  } catch (err) {
    if (err.code === 11000) return CustomerPoints.findOne({ companyId, customerEmail: email });
    throw err;
  }
}

/**
 * Award points to a customer (auto-earn from a purchase, or a manual bonus).
 * Never throws — a loyalty failure must never break the order/invoice flow
 * that triggered it.
 */
async function awardPointsToCustomer(companyId, customer, points, opts = {}) {
  const { description, orderId, invoiceId, type = 'earned', expiryDays } = opts;
  if (!points || points <= 0) return null;
  try {
    const record = await findOrCreatePoints(companyId, customer);
    if (!record) return null;

    const program = await LoyaltyProgram.findOne({ companyId }).select('expiryDays tiers');
    const days = expiryDays ?? program?.expiryDays ?? 365;
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : undefined;

    record.transactions.push({ type, points, description, orderId, invoiceId, expiresAt, createdAt: new Date() });
    record.currentPoints += points;
    if (type === 'earned' || type === 'bonus') record.totalPointsEarned += points;
    record.tier = resolveTier(record.currentPoints, program?.tiers);
    record.lastActivityAt = new Date();
    await record.save();
    return record;
  } catch (err) {
    logger.warn(`Loyalty award failed: ${err.message}`);
    return null;
  }
}

/**
 * Deduct points already validated by the caller (redeemPoints controller, or
 * storefront checkout fulfilment after a discounted payment succeeds).
 */
async function deductPointsFromCustomer(companyId, customer, points, opts = {}) {
  const { description, orderId, invoiceId } = opts;
  if (!points || points <= 0) return null;
  try {
    const record = await findOrCreatePoints(companyId, customer);
    if (!record || record.currentPoints < points) return null;

    const program = await LoyaltyProgram.findOne({ companyId }).select('tiers');
    record.transactions.push({ type: 'redeemed', points: -points, description, orderId, invoiceId, createdAt: new Date() });
    record.currentPoints -= points;
    record.totalRedeemed += points;
    record.tier = resolveTier(record.currentPoints, program?.tiers);
    record.lastActivityAt = new Date();
    await record.save();
    return record;
  } catch (err) {
    logger.warn(`Loyalty redeem failed: ${err.message}`);
    return null;
  }
}

/**
 * Sweep transactions past their expiresAt that haven't been processed yet and
 * claw the points back out of currentPoints (floored at 0). This is an
 * approximation, not true FIFO ledger accounting — a customer who redeemed
 * points after earning them keeps their balance from ever going negative,
 * but which specific earned batch "paid for" a redemption isn't tracked.
 */
async function expireOldPoints() {
  const now = new Date();
  const candidates = await CustomerPoints.find({
    transactions: { $elemMatch: { type: { $in: ['earned', 'bonus'] }, expiresAt: { $lte: now }, expiredProcessed: { $ne: true } } },
  });

  let swept = 0;
  for (const record of candidates) {
    let totalExpiring = 0;
    for (const tx of record.transactions) {
      if (['earned', 'bonus'].includes(tx.type) && tx.expiresAt && tx.expiresAt <= now && !tx.expiredProcessed) {
        tx.expiredProcessed = true;
        totalExpiring += tx.points;
      }
    }
    if (totalExpiring <= 0) continue;

    const deducted = Math.min(record.currentPoints, totalExpiring);
    if (deducted > 0) {
      record.currentPoints -= deducted;
      record.transactions.push({ type: 'expired', points: -deducted, description: `${deducted} point(s) expired`, createdAt: now });
      const program = await LoyaltyProgram.findOne({ companyId: record.companyId }).select('tiers');
      record.tier = resolveTier(record.currentPoints, program?.tiers);
    }
    await record.save();
    swept += 1;
  }
  if (swept) logger.warn(`Loyalty: expired points swept for ${swept} customer(s)`);
  return swept;
}

module.exports = {
  DEFAULT_TIERS, resolveTier, findOrCreatePoints, awardPointsToCustomer, deductPointsFromCustomer, expireOldPoints,
};
