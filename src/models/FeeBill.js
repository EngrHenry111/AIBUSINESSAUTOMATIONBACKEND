'use strict';

const mongoose = require('mongoose');

// One student's bill for a term. amountPaid/balance move only through atomic
// updates in schoolFeeController, so concurrent payments (a bursar at the
// desk and a parent paying online at the same moment) always add up.
const feeBillSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  billNumber: { type: String, required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' },
  feeStructureId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeStructure' },
  title: { type: String, trim: true, maxlength: 200 },
  session: { type: String, required: true },
  term: { type: String, enum: ['first', 'second', 'third'], required: true },
  items: [{ name: String, amount: Number, _id: false }],
  subtotal: { type: Number, default: 0 },
  discount: { type: Number, default: 0, min: 0 },
  discountReason: { type: String, trim: true, maxlength: 300 },
  total: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0 },
  balance: { type: Number, default: 0 }, // negative = overpaid (credit)
  status: { type: String, enum: ['unpaid', 'partial', 'paid', 'waived', 'cancelled'], default: 'unpaid' },
  dueDate: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastReminderAt: Date,
  reminderCount: { type: Number, default: 0 },
}, { timestamps: true });

feeBillSchema.index({ companyId: 1, billNumber: 1 }, { unique: true });
// A structure bills each student once, so re-running "generate" is safe.
feeBillSchema.index({ studentId: 1, feeStructureId: 1 }, { unique: true, partialFilterExpression: { feeStructureId: { $type: 'objectId' } } });
feeBillSchema.index({ companyId: 1, session: 1, term: 1, status: 1 });
feeBillSchema.index({ companyId: 1, studentId: 1, createdAt: -1 });

module.exports = mongoose.model('FeeBill', feeBillSchema);
