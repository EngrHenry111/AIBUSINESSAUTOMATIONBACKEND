'use strict';

const mongoose = require('mongoose');

// A dedicated bank account number (Paystack dedicated virtual account) that
// belongs to one payer — a student today, an invoice customer later. Money
// transferred into it is matched to that payer automatically.
const virtualAccountSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  ownerType: { type: String, enum: ['student'], required: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  paystackCustomerCode: { type: String, required: true },
  paystackDvaId: { type: Number },
  accountNumber: { type: String, required: true },
  accountName: { type: String },
  bankName: { type: String },
  bankSlug: { type: String },
  active: { type: Boolean, default: true },
}, { timestamps: true });

virtualAccountSchema.index({ companyId: 1, ownerType: 1, ownerId: 1 }, { unique: true });
virtualAccountSchema.index({ accountNumber: 1 });
virtualAccountSchema.index({ paystackCustomerCode: 1 });

module.exports = mongoose.model('VirtualAccount', virtualAccountSchema);
