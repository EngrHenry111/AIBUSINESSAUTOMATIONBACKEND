'use strict';

const mongoose = require('mongoose');

// Money received from a patient against a bill. Voiding keeps the record
// (with who and why) and takes the amount back off the bill.
const hospitalPaymentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  receiptNumber: { type: String, required: true },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalBill', required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, enum: ['cash', 'pos', 'bank_transfer', 'cheque', 'online'], default: 'cash' },
  reference: { type: String, trim: true, maxlength: 100 },
  note: { type: String, trim: true, maxlength: 300 },
  paidAt: { type: Date, default: Date.now },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voided: { type: Boolean, default: false },
  voidedAt: Date,
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voidReason: { type: String, trim: true, maxlength: 300 },
}, { timestamps: true });

hospitalPaymentSchema.index({ companyId: 1, receiptNumber: 1 }, { unique: true });
hospitalPaymentSchema.index({ companyId: 1, paidAt: -1 });
hospitalPaymentSchema.index({ companyId: 1, billId: 1 });
hospitalPaymentSchema.index({ companyId: 1, patientId: 1, paidAt: -1 });

module.exports = mongoose.model('HospitalPayment', hospitalPaymentSchema);
