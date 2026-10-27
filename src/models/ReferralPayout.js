'use strict';

const mongoose = require('mongoose');

// Money taken out of a referral balance: either a cash withdrawal to a bank
// account (a super admin sends it and marks it paid) or a month of the
// company's own subscription paid from the balance (settled at once).
const referralPayoutSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['cash', 'credit'], required: true },
  amount: { type: Number, required: true }, // naira
  status: { type: String, enum: ['requested', 'paid', 'rejected'], default: 'requested' },
  bank: {
    bankName: String,
    bankCode: String,
    accountNumber: String,
    accountName: String,
  },
  // Cash only: the account also receives store payouts for a company this
  // one referred, which suggests a self-referral. Shown to the admin.
  flagged: { type: Boolean, default: false },
  plan: String, // credit only: the plan the month was added to
  processedAt: Date,
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: String,
}, { timestamps: true });

referralPayoutSchema.index({ companyId: 1, createdAt: -1 });
referralPayoutSchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ReferralPayout', referralPayoutSchema);
