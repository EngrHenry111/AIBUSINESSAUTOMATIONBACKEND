'use strict';

const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['earned', 'redeemed', 'expired', 'bonus'], required: true },
  points: { type: Number, required: true },
  description: String,
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  expiresAt: Date,
  // Set once an 'earned'/'bonus' transaction's points have been swept out by
  // the expiry job, so the sweep never double-deducts the same batch.
  expiredProcessed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const customerPointsSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerEmail: { type: String, required: true, trim: true, lowercase: true },
  customerName: { type: String, trim: true },
  totalPointsEarned: { type: Number, default: 0 },
  currentPoints: { type: Number, default: 0 },
  totalRedeemed: { type: Number, default: 0 },
  tier: { type: String, default: 'Bronze' },
  transactions: { type: [transactionSchema], default: [] },
  lastActivityAt: Date,
}, { timestamps: true });

customerPointsSchema.index({ companyId: 1, customerEmail: 1 }, { unique: true });
customerPointsSchema.index({ companyId: 1, currentPoints: -1 });
customerPointsSchema.index({ companyId: 1, tier: 1 });

module.exports = mongoose.model('CustomerPoints', customerPointsSchema);
