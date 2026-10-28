'use strict';

const mongoose = require('mongoose');

// 10% (referrals.RATE) of one subscription payment made by a referred company, owed to the
// company that referred them. One row per payment reference, so the verify
// call and the webhook for the same charge can't both pay out.
const referralEarningSchema = new mongoose.Schema({
  referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  referredCompanyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  paymentReference: { type: String, required: true, unique: true },
  paymentAmount: { type: Number, required: true }, // naira
  rate: { type: Number, required: true },
  amount: { type: Number, required: true },        // naira earned
  plan: String,
  billingCycle: String,
  // Spendable once availableAt passes (a hold in case the payment is
  // reversed). A super admin can reverse a row; it then stops counting.
  availableAt: { type: Date, required: true },
  status: { type: String, enum: ['earned', 'reversed'], default: 'earned' },
  reversedAt: Date,
  reversedReason: String,
}, { timestamps: true });

referralEarningSchema.index({ referrerId: 1, createdAt: -1 });

module.exports = mongoose.model('ReferralEarning', referralEarningSchema);
