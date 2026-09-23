'use strict';

const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  address: { type: String, trim: true },
  rcNumber: { type: String, trim: true },
  tinNumber: { type: String, trim: true },
  category: { type: [String], default: [] }, // what they supply
  bankName: { type: String, trim: true },
  accountNumber: { type: String, trim: true },
  accountName: { type: String, trim: true },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  totalOrders: { type: Number, default: 0 },
  totalValue: { type: Number, default: 0 },
  isPrequalified: { type: Boolean, default: false },
  blacklisted: { type: Boolean, default: false },
  documents: [{
    type: { type: String, trim: true }, // CAC, TIN, PENCOM etc
    url: String,
    expiresAt: Date,
  }],
  notes: { type: String, maxlength: 2000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

vendorSchema.index({ companyId: 1, blacklisted: 1 });
vendorSchema.index({ companyId: 1, isPrequalified: 1 });
vendorSchema.index({ companyId: 1, name: 'text', category: 'text' });

module.exports = mongoose.model('Vendor', vendorSchema);
