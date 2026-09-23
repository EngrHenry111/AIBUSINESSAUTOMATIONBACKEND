'use strict';

const mongoose = require('mongoose');

// `allocated`/`spent`/`available` are maintained here (not derived on read)
// so a budget line's utilization is a single fast lookup — kept in sync by
// procurementController whenever a requisition against this code is
// approved/cancelled.
const procurementBudgetSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  year: { type: Number, required: true },
  department: { type: String, trim: true },
  code: { type: String, required: true, trim: true },
  description: { type: String, trim: true, maxlength: 500 },
  totalBudget: { type: Number, required: true, min: 0 },
  allocated: { type: Number, default: 0 }, // committed to pending/approved requisitions
  spent: { type: Number, default: 0 }, // actually paid out (completed requisitions)
  currency: { type: String, default: 'NGN' },
}, { timestamps: true });

procurementBudgetSchema.virtual('available').get(function () {
  return this.totalBudget - this.allocated;
});
procurementBudgetSchema.set('toJSON', { virtuals: true });
procurementBudgetSchema.set('toObject', { virtuals: true });

procurementBudgetSchema.index({ companyId: 1, year: 1, code: 1 }, { unique: true });
procurementBudgetSchema.index({ companyId: 1, department: 1 });

module.exports = mongoose.model('ProcurementBudget', procurementBudgetSchema);
