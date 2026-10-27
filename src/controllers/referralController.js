'use strict';

const Company = require('../models/Company');
const Payment = require('../models/Payment');
const ReferralEarning = require('../models/ReferralEarning');
const ReferralPayout = require('../models/ReferralPayout');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { paystackAPI } = require('../utils/paystack');
const referrals = require('../utils/referrals');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const mask = (acct) => (acct && acct.length >= 4 ? `****${acct.slice(-4)}` : acct || null);

const isPaying = (sub = {}) => sub.plan !== 'trial' && ['active', 'cancelled'].includes(sub.status)
  && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > new Date();

// ── GET /referrals — the owner's link, balance, referred companies ───────
exports.getMine = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('companyName createdAt referral subscription');
    if (!company) return next(new AppError('Company not found.', 404));
    const code = await referrals.codeFor(company);

    const [balance, referred, earnings, payouts, byCompany, lastCash, referredBy, hasPaid] = await Promise.all([
      referrals.balanceOf(company._id),
      Company.find({ 'referral.referredBy': company._id })
        .select('companyName createdAt referral.referredAt subscription.plan subscription.status subscription.currentPeriodEnd')
        .sort({ 'referral.referredAt': -1 }).limit(500).lean(),
      ReferralEarning.find({ referrerId: company._id }).sort({ createdAt: -1 }).limit(50)
        .populate('referredCompanyId', 'companyName').lean(),
      ReferralPayout.find({ companyId: company._id }).sort({ createdAt: -1 }).limit(20).lean(),
      ReferralEarning.aggregate([
        { $match: { referrerId: company._id, status: 'earned' } },
        { $group: { _id: '$referredCompanyId', earned: { $sum: '$amount' } } },
      ]),
      ReferralPayout.findOne({ companyId: company._id, type: 'cash' }).sort({ createdAt: -1 }).lean(),
      company.referral?.referredBy ? Company.findById(company.referral.referredBy).select('companyName').lean() : null,
      Payment.exists({ companyId: company._id, status: 'success', amount: { $gt: 0 } }),
    ]);
    const earnedBy = new Map(byCompany.map((r) => [String(r._id), r.earned]));
    const sub = company.subscription || {};
    const runningPlan = sub.plan !== 'trial' && sub.status !== 'expired' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > new Date()
      ? sub.plan : null;

    res.status(200).json({
      success: true,
      data: {
        code,
        link: `${clientUrl()}/register?ref=${code}`,
        rate: referrals.RATE,
        holdDays: referrals.HOLD_DAYS,
        minWithdrawal: referrals.MIN_CASH,
        balance,
        referred: referred.map((c) => ({
          _id: c._id,
          companyName: c.companyName,
          joinedAt: c.referral?.referredAt || c.createdAt,
          plan: c.subscription?.plan,
          paying: isPaying(c.subscription),
          earned: Math.round((earnedBy.get(String(c._id)) || 0) * 100) / 100,
        })),
        payingCount: referred.filter((c) => isPaying(c.subscription)).length,
        earnings: earnings.map((e) => ({
          _id: e._id,
          companyName: e.referredCompanyId?.companyName || 'A referred company',
          paymentAmount: e.paymentAmount,
          amount: e.amount,
          plan: e.plan,
          billingCycle: e.billingCycle,
          status: e.status,
          available: e.status === 'earned' && new Date(e.availableAt) <= new Date(),
          availableAt: e.availableAt,
          createdAt: e.createdAt,
        })),
        payouts: payouts.map((p) => ({
          _id: p._id, type: p.type, amount: p.amount, status: p.status, plan: p.plan, note: p.note,
          bank: p.bank ? { bankName: p.bank.bankName, accountName: p.bank.accountName, accountNumber: mask(p.bank.accountNumber) } : undefined,
          createdAt: p.createdAt, processedAt: p.processedAt,
        })),
        openWithdrawal: payouts.some((p) => p.type === 'cash' && p.status === 'requested'),
        lastBank: lastCash?.bank ? { bankName: lastCash.bank.bankName, bankCode: lastCash.bank.bankCode, accountNumber: lastCash.bank.accountNumber } : null,
        referredBy: referredBy ? { companyName: referredBy.companyName } : null,
        canClaim: !company.referral?.referredBy && !hasPaid
          && Date.now() - new Date(company.createdAt) <= referrals.CLAIM_DAYS * 24 * 60 * 60 * 1000,
        runningPlan,
        monthPrice: runningPlan ? await referrals.monthPrice(company, runningPlan) : null,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /referrals/claim — add the code you were referred with ──────────
exports.claim = async (req, res, next) => {
  try {
    const referrer = await referrals.attach(req.companyId, req.body.code);
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'referral.claim', description: `Referred by ${referrer.companyName}`, ip: req.ip,
    });
    res.status(200).json({ success: true, message: `Linked to ${referrer.companyName}.`, data: { companyName: referrer.companyName } });
  } catch (err) { next(err); }
};

// ── POST /referrals/use-balance — a month of your own plan ───────────────
exports.useBalance = async (req, res, next) => {
  try {
    const result = await referrals.payMonthFromBalance(req.companyId, req.user._id, req.body.plan);
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'referral.credit', description: `Paid a month of ${result.plan} (₦${result.payout.amount.toLocaleString()}) from referral balance`, ip: req.ip,
    });
    res.status(200).json({ success: true, message: 'A month was added to your plan.', data: { currentPeriodEnd: result.currentPeriodEnd, plan: result.plan } });
  } catch (err) { next(err); }
};

// ── POST /referrals/withdraw — cash to a bank account ────────────────────
exports.withdraw = async (req, res, next) => {
  try {
    const { bankCode, bankName, accountNumber, amount } = req.body;
    if (!/^\d{10}$/.test(String(accountNumber || ''))) return next(new AppError('Enter a valid 10-digit account number.', 400));
    if (!bankCode) return next(new AppError('Select a bank.', 400));
    let accountName;
    try {
      const r = await paystackAPI('GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${encodeURIComponent(bankCode)}`);
      accountName = r.data?.account_name;
    } catch (err) {
      if (/could not resolve|unknown bank|invalid account/i.test(err.message || '')) {
        return next(new AppError('That account number was not found at the selected bank.', 400));
      }
      throw err;
    }
    if (!accountName) return next(new AppError('That account number was not found at the selected bank.', 400));

    const payout = await referrals.requestCash(req.companyId, req.user._id, {
      amount,
      bank: { bankCode: String(bankCode), bankName: String(bankName || '').slice(0, 100), accountNumber: String(accountNumber), accountName },
    });
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'referral.withdraw', description: `Requested ₦${payout.amount.toLocaleString()} to ${accountName}`, ip: req.ip,
    });
    res.status(201).json({ success: true, message: `Withdrawal of ₦${payout.amount.toLocaleString()} to ${accountName} requested.`, data: { _id: payout._id } });
  } catch (err) { next(err); }
};

// ── Super admin ──────────────────────────────────────────────────────────
exports.adminOverview = async (req, res, next) => {
  try {
    const [totals, payoutTotals, top, requests] = await Promise.all([
      ReferralEarning.aggregate([
        { $match: { status: 'earned' } },
        { $group: { _id: null, earned: { $sum: '$amount' }, revenue: { $sum: '$paymentAmount' }, count: { $sum: 1 } } },
      ]),
      ReferralPayout.aggregate([
        { $match: { status: { $ne: 'rejected' } } },
        { $group: { _id: { type: '$type', status: '$status' }, amount: { $sum: '$amount' } } },
      ]),
      ReferralEarning.aggregate([
        { $match: { status: 'earned' } },
        { $group: { _id: '$referrerId', earned: { $sum: '$amount' }, revenue: { $sum: '$paymentAmount' }, companies: { $addToSet: '$referredCompanyId' } } },
        { $sort: { earned: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'companies', localField: '_id', foreignField: '_id', as: 'c' } },
        { $project: { earned: 1, revenue: 1, companies: { $size: '$companies' }, companyName: { $arrayElemAt: ['$c.companyName', 0] } } },
      ]),
      ReferralPayout.find({ type: 'cash', ...(req.query.status ? { status: req.query.status } : {}) })
        .sort({ createdAt: -1 }).limit(100).populate('companyId', 'companyName').lean(),
    ]);
    const sumOf = (type, status) => payoutTotals.filter((p) => p._id.type === type && (!status || p._id.status === status))
      .reduce((a, p) => a + p.amount, 0);
    res.status(200).json({
      success: true,
      data: {
        earned: totals[0]?.earned || 0,
        referredRevenue: totals[0]?.revenue || 0,
        payments: totals[0]?.count || 0,
        referredCompanies: await Company.countDocuments({ 'referral.referredBy': { $exists: true } }),
        cashPaid: sumOf('cash', 'paid'),
        cashWaiting: sumOf('cash', 'requested'),
        creditUsed: sumOf('credit'),
        top,
        withdrawals: requests.map((p) => ({ ...p, companyName: p.companyId?.companyName, companyId: p.companyId?._id })),
      },
    });
  } catch (err) { next(err); }
};

exports.adminSettle = async (req, res, next) => {
  try {
    const paid = req.body.action === 'paid';
    if (!paid && req.body.action !== 'reject') return next(new AppError('Action must be paid or reject.', 400));
    const payout = await referrals.settleCash(req.params.id, req.user._id, { paid, note: String(req.body.note || '').slice(0, 300) || undefined });
    await writeAuditLog({
      companyId: payout.companyId, userId: req.user._id,
      action: paid ? 'referral.payout_paid' : 'referral.payout_rejected',
      description: `₦${payout.amount.toLocaleString()} withdrawal ${paid ? 'paid' : 'rejected'}`, ip: req.ip,
    });
    res.status(200).json({ success: true, data: payout });
  } catch (err) { next(err); }
};

exports.adminReverse = async (req, res, next) => {
  try {
    const earning = await referrals.reverseEarning(req.params.id, String(req.body.reason || '').slice(0, 300) || undefined);
    await writeAuditLog({
      companyId: earning.referrerId, userId: req.user._id,
      action: 'referral.reverse', description: `Reversed ₦${earning.amount.toLocaleString()} earning (${earning.paymentReference})`, ip: req.ip,
    });
    res.status(200).json({ success: true, data: earning });
  } catch (err) { next(err); }
};

// A referrer's earnings, for the admin to check before paying out.
exports.adminEarnings = async (req, res, next) => {
  try {
    const earnings = await ReferralEarning.find({ referrerId: req.params.companyId }).sort({ createdAt: -1 }).limit(200)
      .populate('referredCompanyId', 'companyName').lean();
    res.status(200).json({ success: true, data: earnings });
  } catch (err) { next(err); }
};
