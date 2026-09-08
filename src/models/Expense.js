'use strict';

const mongoose = require('mongoose');

const CATEGORIES = [
  'rent', 'salaries', 'utilities', 'supplies',
  'marketing', 'transport', 'equipment', 'maintenance',
  'taxes', 'insurance', 'software', 'food',
  'entertainment', 'other',
];

const expenseSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'NGN' },
  category: { type: String, enum: CATEGORIES, default: 'other' },
  date: { type: Date, required: true },
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'card', 'cheque', 'other'],
    default: 'cash',
  },
  receipt: { type: String },
  vendor: { type: String, trim: true },
  isRecurring: { type: Boolean, default: false },
  recurringInterval: { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly', null], default: null },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tags: { type: [String], default: [] },
}, { timestamps: true });

expenseSchema.index({ companyId: 1, date: -1 });
expenseSchema.index({ companyId: 1, category: 1 });
expenseSchema.index({ companyId: 1, createdBy: 1 });

expenseSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('Expense', expenseSchema);
