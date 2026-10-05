'use strict';

const mongoose = require('mongoose');

// A receipt. Never deleted — a mistaken payment is voided (with a reason),
// which reverses it on the bill and keeps the audit trail.
const feePaymentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  receiptNumber: { type: String, required: true },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeBill', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, enum: ['cash', 'bank_transfer', 'pos', 'cheque', 'online'], default: 'cash' },
  reference: { type: String, trim: true, maxlength: 120 },
  paystackReference: { type: String, trim: true },
  payerName: { type: String, trim: true, maxlength: 200 },
  payerEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
  note: { type: String, trim: true, maxlength: 500 },
  paidAt: { type: Date, default: Date.now },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voided: { type: Boolean, default: false },
  voidedAt: Date,
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voidReason: { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });

feePaymentSchema.index({ companyId: 1, receiptNumber: 1 }, { unique: true });
// One receipt per Paystack charge — the webhook and the verify call race.
feePaymentSchema.index({ paystackReference: 1 }, { unique: true, partialFilterExpression: { paystackReference: { $type: 'string' } } });
feePaymentSchema.index({ companyId: 1, paidAt: -1 });
feePaymentSchema.index({ companyId: 1, billId: 1 });
feePaymentSchema.index({ companyId: 1, studentId: 1, paidAt: -1 });

module.exports = mongoose.model('FeePayment', feePaymentSchema);
