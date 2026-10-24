'use strict';

const mongoose = require('mongoose');

// Every change to a pharmacy item's stock, for the stock card and audits.
const pharmacyStockMoveSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyItem', required: true },
  type: { type: String, enum: ['received', 'dispensed', 'returned', 'adjusted', 'expired', 'damaged'], required: true },
  quantity: { type: Number, required: true }, // + in, - out
  balanceAfter: Number,
  batchNo: String,
  prescriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  supplier: { type: String, trim: true, maxlength: 160 },
  unitCost: Number,
  note: { type: String, trim: true, maxlength: 300 },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pharmacyStockMoveSchema.index({ companyId: 1, itemId: 1, createdAt: -1 });
pharmacyStockMoveSchema.index({ companyId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('PharmacyStockMove', pharmacyStockMoveSchema);
