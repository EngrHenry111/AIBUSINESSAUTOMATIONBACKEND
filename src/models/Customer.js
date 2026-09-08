'use strict';

const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  address: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  company: { type: String, trim: true },
  type: { type: String, enum: ['individual', 'business'], default: 'individual' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  notes: { type: String, maxlength: 5000 },
  tags: { type: [String], default: [] },
  convertedFromLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  totalOrders: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  lastOrderAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

customerSchema.index({ companyId: 1, status: 1 });
customerSchema.index({ companyId: 1, email: 1 });
customerSchema.index({ companyId: 1, name: 'text', email: 'text', company: 'text' });

module.exports = mongoose.model('Customer', customerSchema);
