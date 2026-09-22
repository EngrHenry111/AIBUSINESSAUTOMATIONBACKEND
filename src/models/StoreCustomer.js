'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// A shopper's account on ONE specific store — deliberately separate from the
// main BizlyAI User model (a store customer never logs into the dashboard,
// and the same email can be a StoreCustomer on many different stores).
const storeCustomerSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  password: { type: String, required: true, select: false, minlength: 6 },
  addresses: [{
    label: { type: String, trim: true, default: 'Home' },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
  }],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  orderCount: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: false },
  lastLoginAt: Date,
}, { timestamps: true });

storeCustomerSchema.index({ companyId: 1, email: 1 }, { unique: true });

storeCustomerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

storeCustomerSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('StoreCustomer', storeCustomerSchema);
