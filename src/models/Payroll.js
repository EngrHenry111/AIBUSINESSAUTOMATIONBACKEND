'use strict';

const mongoose = require('mongoose');

const payrollEmployeeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffSalary' },
  name: { type: String, required: true },
  email: { type: String },
  role: { type: String },
  grossSalary: { type: Number, required: true, min: 0 },
  deductions: {
    tax: { type: Number, default: 0 },
    pension: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
  },
  netSalary: { type: Number, required: true },
  bankName: { type: String },
  accountNumber: { type: String },
  accountName: { type: String },
  status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paidAt: { type: Date },
}, { _id: true });

const payrollSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  status: { type: String, enum: ['draft', 'processing', 'paid'], default: 'draft' },
  totalGross: { type: Number, default: 0 },
  totalDeductions: { type: Number, default: 0 },
  totalNet: { type: Number, default: 0 },
  currency: { type: String, default: 'NGN' },
  paidAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  employees: { type: [payrollEmployeeSchema], default: [] },
}, { timestamps: true });

// One payroll run per company per calendar period.
payrollSchema.index({ companyId: 1, year: 1, month: 1 }, { unique: true });
payrollSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model('Payroll', payrollSchema);
