'use strict';

// Referral programme. A company shares its link; when a company that signed
// up through it pays for a subscription (card renewal, transfer, any plan),
// the referrer earns RATE of that payment, for as long as they keep paying.
// Earnings are held for HOLD_DAYS, then the balance can be withdrawn to a
// bank account (from MIN_CASH) or spent on a month of the referrer's own plan.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Branch = require('../models/Branch');
const ReferralEarning = require('../models/ReferralEarning');
const ReferralPayout = require('../models/ReferralPayout');
const { AppError } = require('../middleware/errorMiddleware');
const { enterpriseQuote } = require('./enterprisePricing');
const logger = require('./logger');

const RATE = 0.05;
const HOLD_DAYS = 14;
const MIN_CASH = 5000;
const CLAIM_DAYS = 30; // a code can be added this long after signing up
const DAY = 24 * 60 * 60 * 1000;
const SELF_SERVE_PLANS = ['starter', 'professional', 'business'];

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const naira = (n) => `₦${money(n).toLocaleString()}`;
const normalise = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The company's own code, created the first time it's asked for.
async function codeFor(company) {
  if (company.referral?.code) return company.referral.code;
  const stem = normalise(company.companyName).replace(/[0-9]/g, '').slice(0, 5) || 'BIZLY';
  for (let i = 0; i < 6; i += 1) {
    const code = `${stem}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const updated = await Company.findOneAndUpdate(
        { _id: company._id, 'referral.code': { $exists: false } },
        { $set: { 'referral.code': code } },
        { new: true },
      ).select('referral');
      if (updated) return updated.referral.code;
      // Another request set it first.
      // eslint-disable-next-line no-await-in-loop
      return (await Company.findById(company._id).select('referral')).referral.code;
    } catch (err) {
      if (err.code !== 11000) throw err; // taken by another company — try again
    }
  }
  throw new AppError('Could not create a referral code. Please try again.', 500);
}

// Links a company to the one whose code it used. Only for a new account
// (first CLAIM_DAYS, before its first payment) and never to itself.
async function attach(companyId, rawCode) {
  const code = normalise(rawCode);
  if (!code) throw new AppError('Enter a referral code.', 400);
  const company = await Company.findById(companyId).select('owner createdAt referral');
  if (!company) throw new AppError('Company not found.', 404);
  if (company.referral?.referredBy) throw new AppError('This account is already linked to a referrer.', 400);
  const referrer = await Company.findOne({ 'referral.code': code }).select('companyName owner status referral');
  if (!referrer || referrer.status !== 'active') throw new AppError('That referral code was not found.', 404);
  if (String(referrer._id) === String(company._id)) throw new AppError('You can\'t use your own referral code.', 400);
  if (String(referrer.referral?.referredBy) === String(company._id)) throw new AppError('You referred this account, so it can\'t refer you.', 400);
  if (Date.now() - new Date(company.createdAt) > CLAIM_DAYS * DAY) {
    throw new AppError(`A referral code can only be added in the first ${CLAIM_DAYS} days after signing up.`, 400);
  }
  if (await Payment.exists({ companyId: company._id, status: 'success', amount: { $gt: 0 } })) {
    throw new AppError('A referral code can only be added before your first payment.', 400);
  }
  const owners = await User.find({ _id: { $in: [company.owner, referrer.owner] } }).select('phone');
  const phones = owners.map((u) => String(u.phone || '').replace(/\D/g, '').slice(-10)).filter((p) => p.length === 10);
  if (phones.length === 2 && phones[0] === phones[1]) {
    throw new AppError('That code belongs to an account with your phone number.', 400);
  }
  const linked = await Company.updateOne(
    { _id: company._id, 'referral.referredBy': { $exists: false } },
    { $set: { 'referral.referredBy': referrer._id, 'referral.referredAt': new Date() } },
  );
  if (!linked.modifiedCount) throw new AppError('This account is already linked to a referrer.', 400);
  logger.info(`Referral: ${company._id} linked to ${referrer._id} (${code})`);
  return referrer;
}

// Called for every successful subscription payment. Idempotent per reference.
async function creditReferral({ companyId, reference, amount, plan, billingCycle }) {
  try {
    if (!reference || !(Number(amount) > 0)) return null;
    const company = await Company.findById(companyId).select('referral');
    const referrerId = company?.referral?.referredBy;
    if (!referrerId) return null;
    const earning = await ReferralEarning.create({
      referrerId,
      referredCompanyId: companyId,
      paymentReference: reference,
      paymentAmount: money(amount),
      rate: RATE,
      amount: money(amount * RATE),
      plan,
      billingCycle,
      availableAt: new Date(Date.now() + HOLD_DAYS * DAY),
    });
    logger.info(`Referral: ${referrerId} earned ${naira(earning.amount)} from ${companyId} (${reference})`);
    return earning;
  } catch (err) {
    if (err.code !== 11000) logger.error(`Referral credit failed for ${reference}: ${err.message}`);
    return null;
  }
}

async function balanceOf(companyId) {
  const now = new Date();
  const [row] = await ReferralEarning.aggregate([
    { $match: { referrerId: new mongoose.Types.ObjectId(String(companyId)), status: 'earned' } },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        available: { $sum: { $cond: [{ $lte: ['$availableAt', now] }, '$amount', 0] } },
      },
    },
  ]);
  const company = await Company.findById(companyId).select('referral');
  const spent = money(company?.referral?.spent);
  const total = money(row?.total);
  const available = money(row?.available);
  return {
    totalEarned: total,
    pending: money(total - available),
    spent,
    balance: money(available - spent),
    available,
  };
}

// Takes `amount` out of the balance, or fails if it isn't there. The check
// and the deduction are one atomic update, so two requests can't overdraw.
async function spend(companyId, amount) {
  const { available } = await balanceOf(companyId);
  const ok = await Company.updateOne(
    { _id: companyId, $expr: { $lte: [{ $add: [{ $ifNull: ['$referral.spent', 0] }, amount] }, available + 0.001] } },
    { $inc: { 'referral.spent': amount } },
  );
  return ok.modifiedCount === 1;
}

const giveBack = (companyId, amount) => Company.updateOne({ _id: companyId }, { $inc: { 'referral.spent': -amount } });

async function monthPrice(company, plan) {
  if (plan === 'enterprise') {
    const branches = await Branch.countDocuments({ companyId: company._id, status: 'active' });
    return money(enterpriseQuote(branches).monthly);
  }
  return money(require('../controllers/paymentController').PLANS[plan]?.monthlyAmount);
}

// Pays one month of the company's own plan from its referral balance. A plan
// with days left gets the month added on top; a trial or ended plan starts a
// new month of the chosen plan today. The period only moves if nobody else
// moved it since it was read, so two clicks at once add two months, not one.
async function payMonthFromBalance(companyId, userId, chosenPlan) {
  const { PLANS } = require('../controllers/paymentController');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const company = await Company.findById(companyId).select('companyName subscription referral');
    if (!company) throw new AppError('Company not found.', 404);
    const sub = company.subscription || {};
    const now = new Date();
    const running = sub.plan !== 'trial' && sub.status !== 'expired' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > now;
    const plan = running ? sub.plan : chosenPlan;
    if (!running && !SELF_SERVE_PLANS.includes(plan)) throw new AppError('Choose a plan to pay for.', 400);
    // eslint-disable-next-line no-await-in-loop
    const price = await monthPrice(company, plan);
    if (!(price > 0)) throw new AppError('This plan can\'t be paid from the referral balance.', 400);
    // eslint-disable-next-line no-await-in-loop
    if (!await spend(companyId, price)) {
      // eslint-disable-next-line no-await-in-loop
      const { balance } = await balanceOf(companyId);
      throw new AppError(`A month of ${PLANS[plan]?.name || plan} costs ${naira(price)}; your available balance is ${naira(balance)}.`, 400);
    }

    try {
      const end = new Date(running ? sub.currentPeriodEnd : now);
      end.setMonth(end.getMonth() + 1);
      const features = PLANS[plan].features;
      // eslint-disable-next-line no-await-in-loop
      const moved = await Company.updateOne({ _id: companyId, 'subscription.currentPeriodEnd': sub.currentPeriodEnd || null }, {
        $set: {
          'subscription.plan': plan,
          'subscription.currentPeriodEnd': end,
          'limits.maxUsers': features.maxUsers,
          'limits.maxDocuments': features.maxDocuments,
          'limits.maxQuestionsPerMonth': features.maxQuestionsPerMonth,
          // A new month with no card behind it renews like a transfer payer:
          // reminders before it ends, nothing charged automatically.
          ...(running ? {} : {
            'subscription.status': 'active',
            'subscription.currentPeriodStart': now,
            'subscription.billingCycle': 'monthly',
            'subscription.paymentMethod': 'transfer',
          }),
        },
        $unset: { 'subscription.renewalReminderFor': 1, ...(running ? {} : { 'subscription.cancelledAt': 1 }) },
      });
      if (!moved.modifiedCount) {
        // eslint-disable-next-line no-await-in-loop
        await giveBack(companyId, price);
        continue; // the period changed under us — read it again
      }
      // eslint-disable-next-line no-await-in-loop
      const payout = await ReferralPayout.create({
        companyId, requestedBy: userId, type: 'credit', amount: price, plan, status: 'paid', processedAt: now,
      });
      return { payout, currentPeriodEnd: end, plan };
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await giveBack(companyId, price);
      throw err;
    }
  }
  throw new AppError('Your plan was being updated at the same time. Please try again.', 409);
}

async function requestCash(companyId, userId, { amount, bank }) {
  const { balance } = await balanceOf(companyId);
  const value = money(amount === undefined || amount === '' ? balance : amount);
  if (!(value >= MIN_CASH)) throw new AppError(`The minimum withdrawal is ${naira(MIN_CASH)}; your available balance is ${naira(balance)}.`, 400);
  if (await ReferralPayout.exists({ companyId, type: 'cash', status: 'requested' })) {
    throw new AppError('You already have a withdrawal waiting to be paid.', 400);
  }
  if (!await spend(companyId, value)) throw new AppError(`Your available balance is ${naira(balance)}.`, 400);
  try {
    // Paid into the store-payout account of a company this one referred:
    // probably the same person on both sides. Let the admin decide.
    const flagged = Boolean(await Company.exists({ 'referral.referredBy': companyId, 'paymentSettings.accountNumber': bank.accountNumber }));
    return await ReferralPayout.create({ companyId, requestedBy: userId, type: 'cash', amount: value, bank, flagged });
  } catch (err) {
    await giveBack(companyId, value);
    throw err;
  }
}

// Super admin: settle or refuse a cash request. Refusing returns the money
// to the balance. The status filter makes a double click a no-op.
async function settleCash(payoutId, adminId, { paid, note }) {
  const payout = await ReferralPayout.findOneAndUpdate(
    { _id: payoutId, type: 'cash', status: 'requested' },
    { $set: { status: paid ? 'paid' : 'rejected', processedAt: new Date(), processedBy: adminId, note } },
    { new: true },
  );
  if (!payout) throw new AppError('That withdrawal was already handled.', 400);
  if (!paid) await giveBack(payout.companyId, payout.amount);
  return payout;
}

async function reverseEarning(earningId, reason) {
  const earning = await ReferralEarning.findOneAndUpdate(
    { _id: earningId, status: 'earned' },
    { $set: { status: 'reversed', reversedAt: new Date(), reversedReason: reason } },
    { new: true },
  );
  if (!earning) throw new AppError('That earning was already reversed.', 400);
  return earning;
}

module.exports = {
  RATE, HOLD_DAYS, MIN_CASH, CLAIM_DAYS, SELF_SERVE_PLANS,
  normalise, codeFor, attach, creditReferral, balanceOf, payMonthFromBalance, requestCash, settleCash, reverseEarning, monthPrice,
};
