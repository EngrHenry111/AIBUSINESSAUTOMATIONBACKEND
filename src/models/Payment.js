'use strict';

const mongoose = require('mongoose');

// One row per successful (or attempted) subscription charge. Written by
// paymentController.upgradePlan on Paystack verify + webhook, and read by the
// super-admin revenue endpoints.
const paymentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reference: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },          // major currency unit (e.g. NGN, not kobo)
  currency: { type: String, default: 'NGN' },
  plan: { type: String },
  billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
  status: { type: String, enum: ['success', 'failed', 'pending'], default: 'success' },
  channel: { type: String },
  paidAt: { type: Date, default: Date.now },
}, { timestamps: true });

paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ companyId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, paidAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
