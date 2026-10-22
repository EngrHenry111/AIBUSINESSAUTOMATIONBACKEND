'use strict';

const mongoose = require('mongoose');

// Every change to a stock item's quantity. qty is signed (+ in, − out).
const groupStockMoveSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'GroupStockItem', required: true, index: true },
  itemName: String,
  type: {
    type: String,
    enum: ['opening', 'receive', 'sale', 'sale_reversal', 'adjust', 'transfer_in', 'transfer_out', 'count'],
    required: true,
  },
  qty: { type: Number, required: true },
  balanceAfter: Number,
  unitCost: { type: Number, default: 0 },
  value: { type: Number, default: 0 }, // qty × unitCost (signed)
  // Stock counts: what the books said vs what was physically counted.
  systemQty: Number,
  countedQty: Number,
  supplier: { type: String, trim: true, maxlength: 160 },
  reference: { type: String, trim: true, maxlength: 80 },
  reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'BranchReport', default: null },
  transferId: { type: String, default: null },
  note: { type: String, trim: true, maxlength: 500 },
  byName: String,
  date: { type: Date, default: Date.now },
}, { timestamps: true });

groupStockMoveSchema.index({ companyId: 1, branchId: 1, date: -1 });

module.exports = mongoose.model('GroupStockMove', groupStockMoveSchema);
