'use strict';

const LoyaltyProgram = require('../models/LoyaltyProgram');
const CustomerPoints = require('../models/CustomerPoints');
const { AppError } = require('../middleware/errorMiddleware');
const { DEFAULT_TIERS, awardPointsToCustomer, deductPointsFromCustomer } = require('../utils/loyaltyPoints');

// ── GET /loyalty/program ─────────────────────────────────────────────────
exports.getLoyaltyProgram = async (req, res, next) => {
  try {
    const program = await LoyaltyProgram.findOne({ companyId: req.companyId });
    res.status(200).json({ success: true, data: program });
  } catch (err) { next(err); }
};

// ── POST /loyalty/program ────────────────────────────────────────────────
exports.setupLoyaltyProgram = async (req, res, next) => {
  try {
    const {
      enabled, name, pointsPerNaira, nairaPerPoint, minimumRedemption,
      expiryDays, tiers, welcomePoints, referralPoints, maxPointsPerOrder,
    } = req.body;

    let program = await LoyaltyProgram.findOne({ companyId: req.companyId });
    const isFirstSetup = !program;

    if (!program) {
      program = new LoyaltyProgram({ companyId: req.companyId, tiers: DEFAULT_TIERS });
    }

    if (enabled !== undefined) program.enabled = Boolean(enabled);
    if (name !== undefined) program.name = name;
    if (pointsPerNaira !== undefined) program.pointsPerNaira = Number(pointsPerNaira);
    if (nairaPerPoint !== undefined) program.nairaPerPoint = Number(nairaPerPoint);
    if (minimumRedemption !== undefined) program.minimumRedemption = Number(minimumRedemption);
    if (maxPointsPerOrder !== undefined) program.maxPointsPerOrder = maxPointsPerOrder === '' || maxPointsPerOrder == null ? null : Number(maxPointsPerOrder);
    if (expiryDays !== undefined) program.expiryDays = Number(expiryDays);
    if (welcomePoints !== undefined) program.welcomePoints = Number(welcomePoints);
    if (referralPoints !== undefined) program.referralPoints = Number(referralPoints);
    if (Array.isArray(tiers) && tiers.length) {
      program.tiers = tiers.map((t) => ({
        name: t.name, minimumPoints: Number(t.minimumPoints) || 0,
        benefits: t.benefits || '', badgeColor: t.badgeColor || '#cd7f32',
        discountPercent: Number(t.discountPercent) || 0,
      }));
    } else if (isFirstSetup) {
      program.tiers = DEFAULT_TIERS;
    }

    await program.save();
    res.status(isFirstSetup ? 201 : 200).json({ success: true, data: program });
  } catch (err) { next(err); }
};

// ── GET /loyalty/customers ───────────────────────────────────────────────
exports.getCustomerPoints = async (req, res, next) => {
  try {
    const { tier, minimumPoints, page = 1, limit = 20, search } = req.query;
    const filter = { companyId: req.companyId };
    if (tier) filter.tier = tier;
    if (minimumPoints) filter.currentPoints = { $gte: Number(minimumPoints) };
    if (search) filter.$or = [
      { customerName: { $regex: search, $options: 'i' } },
      { customerEmail: { $regex: search, $options: 'i' } },
    ];

    const skip = (Number(page) - 1) * Number(limit);
    const [customers, total] = await Promise.all([
      CustomerPoints.find(filter).sort({ currentPoints: -1 }).skip(skip).limit(Number(limit))
        .select('-transactions'),
      CustomerPoints.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, data: customers, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

// ── GET /loyalty/customers/:customerId ───────────────────────────────────
exports.getCustomerPointsById = async (req, res, next) => {
  try {
    const record = await CustomerPoints.findOne({ _id: req.params.customerId, companyId: req.companyId });
    if (!record) return next(new AppError('Loyalty record not found.', 404));
    res.status(200).json({ success: true, data: record });
  } catch (err) { next(err); }
};

// ── POST /loyalty/award ───────────────────────────────────────────────────
exports.awardPoints = async (req, res, next) => {
  try {
    const { customerId, points, description } = req.body;
    if (!customerId || !points || Number(points) <= 0) {
      return next(new AppError('customerId and a positive points value are required.', 400));
    }

    const existing = await CustomerPoints.findOne({ _id: customerId, companyId: req.companyId });
    if (!existing) return next(new AppError('Customer not found.', 404));

    const record = await awardPointsToCustomer(
      req.companyId,
      { email: existing.customerEmail, name: existing.customerName },
      Number(points),
      { description: description || 'Bonus points awarded', type: 'bonus' },
    );
    if (!record) return next(new AppError('Could not award points.', 500));

    res.status(200).json({ success: true, data: record });
  } catch (err) { next(err); }
};

// ── POST /loyalty/redeem ──────────────────────────────────────────────────
exports.redeemPoints = async (req, res, next) => {
  try {
    const { customerId, points, invoiceId } = req.body;
    if (!customerId || !points || Number(points) <= 0) {
      return next(new AppError('customerId and a positive points value are required.', 400));
    }

    const program = await LoyaltyProgram.findOne({ companyId: req.companyId });
    if (!program?.enabled) return next(new AppError('Loyalty program is not enabled.', 400));

    const requested = Number(points);
    if (requested < program.minimumRedemption) {
      return next(new AppError(`Minimum redemption is ${program.minimumRedemption} points.`, 400));
    }

    const existing = await CustomerPoints.findOne({ _id: customerId, companyId: req.companyId });
    if (!existing) return next(new AppError('Customer not found.', 404));
    if (existing.currentPoints < requested) {
      return next(new AppError(`Insufficient points. Available: ${existing.currentPoints}.`, 400));
    }

    const discount = Math.round(requested * program.nairaPerPoint * 100) / 100;
    const record = await deductPointsFromCustomer(
      req.companyId,
      { email: existing.customerEmail, name: existing.customerName },
      requested,
      { description: `Redeemed for ₦${discount} discount`, invoiceId },
    );
    if (!record) return next(new AppError('Could not redeem points.', 500));

    res.status(200).json({ success: true, data: { record, discount } });
  } catch (err) { next(err); }
};

// ── GET /loyalty/stats ────────────────────────────────────────────────────
// Powers the dashboard's stats row — computed on demand rather than stored,
// since "this month" resets on its own and the underlying transaction
// volume per company is small enough for a live aggregation to be cheap.
exports.getLoyaltyStats = async (req, res, next) => {
  try {
    const program = await LoyaltyProgram.findOne({ companyId: req.companyId }).select('nairaPerPoint');
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [totalMembers, agg] = await Promise.all([
      CustomerPoints.countDocuments({ companyId: req.companyId, currentPoints: { $gt: 0 } }),
      CustomerPoints.aggregate([
        { $match: { companyId: req.companyId } },
        { $unwind: '$transactions' },
        { $match: { 'transactions.createdAt': { $gte: startOfMonth } } },
        { $group: { _id: '$transactions.type', total: { $sum: '$transactions.points' } } },
      ]),
    ]);

    const issued = agg.filter((a) => ['earned', 'bonus'].includes(a._id)).reduce((s, a) => s + a.total, 0);
    const redeemed = Math.abs(agg.find((a) => a._id === 'redeemed')?.total || 0);
    const nairaPerPoint = program?.nairaPerPoint ?? 0.5;

    res.status(200).json({
      success: true,
      data: {
        totalMembers,
        pointsIssuedThisMonth: issued,
        pointsRedeemedThisMonth: redeemed,
        estimatedDiscountGiven: Math.round(redeemed * nairaPerPoint * 100) / 100,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /loyalty/leaderboard ──────────────────────────────────────────────
exports.getLeaderboard = async (req, res, next) => {
  try {
    const top = await CustomerPoints.find({ companyId: req.companyId })
      .sort({ currentPoints: -1 })
      .limit(10)
      .select('customerName customerEmail currentPoints tier totalPointsEarned');
    res.status(200).json({ success: true, data: top });
  } catch (err) { next(err); }
};
