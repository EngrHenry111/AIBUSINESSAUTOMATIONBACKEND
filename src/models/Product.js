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

  // ── Marketplace upgrade ──────────────────────────────────────────────
  variants: [{
    name: String, // "Size", "Color", "Weight"
    options: [{
      value: String, // "Large", "Red", "1kg"
      price: Number, // overrides base price when selected
      stock: Number,
      sku: String,
    }],
  }],
  ratings: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  reviews: [{
    customerName: String,
    customerEmail: String,
    rating: { type: Number, min: 1, max: 5 },
    comment: { type: String, maxlength: 2000 },
    createdAt: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false }, // purchased this product
  }],
  isFlashSale: { type: Boolean, default: false },
  flashSalePrice: Number,
  flashSaleEndsAt: Date,
  bundle: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, default: 1 },
  }],
  relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  viewCount: { type: Number, default: 0 },
  wishlistCount: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
}, { timestamps: true });

productSchema.index({ companyId: 1, status: 1 });
productSchema.index({ companyId: 1, category: 1 });
productSchema.index({ companyId: 1, sku: 1 }, { unique: true, sparse: true });
productSchema.index({ companyId: 1, name: 'text', description: 'text' });
productSchema.index({ companyId: 1, isFeatured: 1 });
productSchema.index({ companyId: 1, isFlashSale: 1, flashSaleEndsAt: 1 });

// A flash sale is only "live" while it hasn't expired — checked at read time
// rather than a scheduled job, so a stale isFlashSale flag never misleads a
// shopper into a price that's actually reverted.
productSchema.methods.effectivePrice = function () {
  if (this.isFlashSale && this.flashSalePrice != null && (!this.flashSaleEndsAt || this.flashSaleEndsAt > new Date())) {
    return this.flashSalePrice;
  }
  return this.price;
};

// Keep status in sync with stock
productSchema.methods.syncStatus = function () {
  if (this.status === 'inactive') return this;
  if (this.stock.trackStock && this.stock.quantity <= 0) this.status = 'out_of_stock';
  else if (this.stock.quantity > 0 && this.status === 'out_of_stock') this.status = 'active';
  return this;
};

module.exports = mongoose.model('Product', productSchema);
