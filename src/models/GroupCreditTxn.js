'use strict';

const mongoose = require('mongoose');

// One movement on a credit customer's account. amount is signed:
// sales increase what they owe (+), payments reduce it (−).
const groupCreditTxnSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupCreditCustomer', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branchName: String,
  type: { type: String, enum: ['sale', 'payment', 'adjustment', 'reversal'], required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  dueDate: Date,
  method: { type: String, trim: true, maxlength: 30, default: '' }, // payments: cash / transfer / pos / cheque
  reference: { type: String, trim: true, maxlength: 80, default: '' },
  vehicle: { type: String, trim: true, maxlength: 40, default: '' },
  reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'BranchReport', default: null },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  byName: String,
}, { timestamps: true });

groupCreditTxnSchema.index({ customerId: 1, date: 1 });

module.exports = mongoose.model('GroupCreditTxn', groupCreditTxnSchema);
