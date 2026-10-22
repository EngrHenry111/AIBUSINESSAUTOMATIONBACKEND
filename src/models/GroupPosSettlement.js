'use strict';

const mongoose = require('mongoose');

// What the bank actually paid for a branch's POS takings on a given trading
// day (optionally per terminal). Compared against POS recorded in reports.
const groupPosSettlementSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  date: { type: Date, required: true },          // trading day the POS sales happened
  terminalId: { type: String, trim: true, maxlength: 40, default: '' },
  bank: { type: String, trim: true, maxlength: 60, default: '' },
  settledAmount: { type: Number, required: true, min: 0 },
  charges: { type: Number, default: 0, min: 0 }, // bank/MSC charges deducted
  settledOn: Date,
  reference: { type: String, trim: true, maxlength: 80, default: '' },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  byName: String,
}, { timestamps: true });

groupPosSettlementSchema.index({ companyId: 1, branchId: 1, date: 1 });

module.exports = mongoose.model('GroupPosSettlement', groupPosSettlementSchema);
