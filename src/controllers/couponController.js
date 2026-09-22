'use strict';

const Coupon = require('../models/Coupon');
const { AppError } = require('../middleware/errorMiddleware');

// ── GET /coupons ──────────────────────────────────────────────────────────
exports.getCoupons = async (req, res, next) => {
  try {
    const coupons = await Coupon.find({ companyId: req.companyId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: coupons });
  } catch (err) { next(err); }
};

// ── POST /coupons ─────────────────────────────────────────────────────────
exports.createCoupon = async (req, res, next) => {
  try {
    const { code, type, value, minimumOrder, maximumDiscount, usageLimit, expiresAt, applicableProducts } = req.body;
    if (!code || !type || value == null) return next(new AppError('code, type and value are required.', 400));
    if (!['percentage', 'fixed'].includes(type)) return next(new AppError('type must be percentage or fixed.', 400));
    if (type === 'percentage' && (value <= 0 || value > 100)) return next(new AppError('A percentage coupon must be between 1 and 100.', 400));

    const coupon = await Coupon.create({
      companyId: req.companyId,
      code: String(code).trim().toUpperCase(),
      type, value: Number(value),
      minimumOrder: Number(minimumOrder) || 0,
      maximumDiscount: maximumDiscount != null ? Number(maximumDiscount) : undefined,
      usageLimit: usageLimit != null && usageLimit !== '' ? Number(usageLimit) : undefined,
      expiresAt: expiresAt || undefined,
      applicableProducts: Array.isArray(applicableProducts) ? applicableProducts : [],
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, data: coupon });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A coupon with this code already exists.', 409));
    next(err);
  }
};

// ── PUT /coupons/:id ──────────────────────────────────────────────────────
const EDITABLE = ['type', 'value', 'minimumOrder', 'maximumDiscount', 'usageLimit', 'expiresAt', 'isActive', 'applicableProducts'];
exports.updateCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!coupon) return next(new AppError('Coupon not found.', 404));
    EDITABLE.forEach((f) => { if (req.body[f] !== undefined) coupon[f] = req.body[f]; });
    await coupon.save();
    res.status(200).json({ success: true, data: coupon });
  } catch (err) { next(err); }
};

// ── DELETE /coupons/:id ───────────────────────────────────────────────────
exports.deleteCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!coupon) return next(new AppError('Coupon not found.', 404));
    res.status(200).json({ success: true, message: 'Coupon deleted.' });
  } catch (err) { next(err); }
};
