'use strict';

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 5000 },
  category: { type: String, trim: true },
  sku: { type: String, trim: true },
  price: { type: Number, required: true, min: 0 },
  costPrice: { type: Number, min: 0 },
  currency: { type: String, default: 'NGN' },
  images: { type: [String], default: [] },
  stock: {
    quantity: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 5 },
    trackStock: { type: Boolean, default: true },
    allowOutOfStock: { type: Boolean, default: false },
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'out_of_stock'],
    default: 'active',
  },
  sold: { type: Number, default: 0 },
  tags: { type: [String], default: [] },
  weight: { type: Number },
  unit: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

productSchema.index({ companyId: 1, status: 1 });
productSchema.index({ companyId: 1, category: 1 });
productSchema.index({ companyId: 1, sku: 1 }, { unique: true, sparse: true });
productSchema.index({ companyId: 1, name: 'text', description: 'text' });

// Keep status in sync with stock
productSchema.methods.syncStatus = function () {
  if (this.status === 'inactive') return this;
  if (this.stock.trackStock && this.stock.quantity <= 0) this.status = 'out_of_stock';
  else if (this.stock.quantity > 0 && this.status === 'out_of_stock') this.status = 'active';
  return this;
};

module.exports = mongoose.model('Product', productSchema);
