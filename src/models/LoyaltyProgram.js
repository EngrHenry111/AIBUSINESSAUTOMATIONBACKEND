'use strict';

const mongoose = require('mongoose');

const tierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  minimumPoints: { type: Number, required: true, default: 0 },
  benefits: { type: String, default: '' },
  badgeColor: { type: String, default: '#cd7f32' },
  discountPercent: { type: Number, default: 0 },
}, { _id: false });

const loyaltyProgramSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  enabled: { type: Boolean, default: false },
  name: { type: String, default: 'Rewards Program', trim: true, maxlength: 100 },
  pointsPerNaira: { type: Number, default: 1 }, // 1 point per ₦1 spent
  nairaPerPoint: { type: Number, default: 0.5 }, // ₦0.50 value per point
  minimumRedemption: { type: Number, default: 100 }, // minimum points to redeem
  expiryDays: { type: Number, default: 365 }, // points expire after 1 year
  tiers: { type: [tierSchema], default: [] },
  welcomePoints: { type: Number, default: 50 },
  referralPoints: { type: Number, default: 100 },
}, { timestamps: true });

module.exports = mongoose.model('LoyaltyProgram', loyaltyProgramSchema);
