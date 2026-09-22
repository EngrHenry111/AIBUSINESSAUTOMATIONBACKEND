'use strict';

const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  type: { type: String, enum: ['percentage', 'fixed'], required: true },
  value: { type: Number, required: true, min: 0 }, // 10 = 10% OR ₦10
  minimumOrder: { type: Number, default: 0 },
  maximumDiscount: Number, // caps a percentage coupon's discount in Naira
  usageLimit: Number, // null/undefined = unlimited
  usedCount: { type: Number, default: 0 },
  expiresAt: Date,
  isActive: { type: Boolean, default: true },
  applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], // empty = all products
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

couponSchema.index({ companyId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Coupon', couponSchema);
