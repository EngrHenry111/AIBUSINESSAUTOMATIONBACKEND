'use strict';

const mongoose = require('mongoose');

const stockLogSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  adjustment: { type: Number, required: true },      // +10 or -5
  reason: { type: String, default: 'manual' },        // restock, sale, damage, lost, return, manual
  note: { type: String },
  previousQuantity: { type: Number, required: true },
  newQuantity: { type: Number, required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

stockLogSchema.index({ companyId: 1, productId: 1, createdAt: -1 });

module.exports = mongoose.model('StockLog', stockLogSchema);
