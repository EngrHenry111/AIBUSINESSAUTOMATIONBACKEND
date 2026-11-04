'use strict';

const mongoose = require('mongoose');

// Quick Sale receipt numbers (POS-2026-00001…), one sequence per company per
// year. $inc'd atomically so tills selling at the same moment get the next
// number each, with no gaps or repeats.
const saleCounterSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  key: { type: String, required: true }, // "pos:2026"
  seq: { type: Number, default: 0 },
});

saleCounterSchema.index({ companyId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('SaleCounter', saleCounterSchema);
