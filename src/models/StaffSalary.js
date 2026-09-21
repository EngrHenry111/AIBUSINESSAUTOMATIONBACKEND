'use strict';

const mongoose = require('mongoose');

const staffSalarySchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional — a staff member need not have an app login
  name: { type: String, required: true, trim: true, maxlength: 150 },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true }, // for payslip SMS
  role: { type: String, trim: true, maxlength: 100 },
  department: { type: String, trim: true, maxlength: 100 },
  grossSalary: { type: Number, required: true, min: 0 },
  bankName: { type: String, trim: true },
  bankCode: { type: String, trim: true },
  accountNumber: { type: String, trim: true },
  accountName: { type: String, trim: true },
  // Nigerian payroll defaults — PAYE and PenCom employee contribution rates.
  // Stored per-staff (not hardcoded) so a business can adjust for a specific
  // employee without affecting anyone else already on the default.
  taxRate: { type: Number, default: 7.5, min: 0, max: 100 },
  pensionRate: { type: Number, default: 8, min: 0, max: 100 },
  otherDeduction: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  startDate: { type: Date, default: Date.now },
  currency: { type: String, default: 'NGN' },
}, { timestamps: true });

staffSalarySchema.index({ companyId: 1, isActive: 1 });
staffSalarySchema.index({ companyId: 1, email: 1 });

module.exports = mongoose.model('StaffSalary', staffSalarySchema);
