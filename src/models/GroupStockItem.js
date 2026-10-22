'use strict';

const mongoose = require('mongoose');

// A stock line held at one branch (cement, rods, roofing sheets, lubricants…).
// `quantity` is the running balance; every change is written as a
// GroupStockMove so the history can always explain the number.
const groupStockItemSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  sku: { type: String, trim: true, maxlength: 40, default: '' },
  unit: { type: String, trim: true, maxlength: 30, default: 'pcs' },
  department: { type: String, trim: true, maxlength: 60, default: '' },
  costPrice: { type: Number, default: 0, min: 0 },
  sellingPrice: { type: Number, default: 0, min: 0 },
  quantity: { type: Number, default: 0 },
  reorderLevel: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

groupStockItemSchema.index({ companyId: 1, branchId: 1, name: 1 });

module.exports = mongoose.model('GroupStockItem', groupStockItemSchema);
