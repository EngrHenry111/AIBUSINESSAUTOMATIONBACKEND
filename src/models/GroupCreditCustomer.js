'use strict';

const mongoose = require('mongoose');

// A company, fleet or individual allowed to buy now and pay later.
// `balance` is a cached running total of GroupCreditTxn amounts.
const groupCreditCustomerSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  kind: { type: String, enum: ['company', 'fleet', 'government', 'individual'], default: 'company' },
  contactName: { type: String, trim: true, maxlength: 120, default: '' },
  phone: { type: String, trim: true, maxlength: 30, default: '' },
  email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
  address: { type: String, trim: true, maxlength: 300, default: '' },
  creditLimit: { type: Number, default: 0, min: 0 },   // 0 = no limit set
  termsDays: { type: Number, default: 30, min: 0, max: 365 },
  autoRemind: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  balance: { type: Number, default: 0 },
  lastReminderAt: Date,
}, { timestamps: true });

groupCreditCustomerSchema.index({ companyId: 1, name: 1 });

module.exports = mongoose.model('GroupCreditCustomer', groupCreditCustomerSchema);
