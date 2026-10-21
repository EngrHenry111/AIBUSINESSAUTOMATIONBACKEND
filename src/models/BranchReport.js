'use strict';

const mongoose = require('mongoose');

// A department's daily sales report. It moves through two approvals —
// branch manager, then the group owner — and only once the owner approves
// does it get a ledger number and count in the final approved sales.
const pumpLineSchema = new mongoose.Schema({
  pump: { type: String, required: true, trim: true },
  product: { type: String, enum: ['PMS', 'AGO', 'DPK', 'LPG'], default: 'PMS' },
  openingMeter: { type: Number, required: true, min: 0 },
  closingMeter: { type: Number, required: true, min: 0 },
  pricePerLitre: { type: Number, required: true, min: 0 },
  litres: { type: Number, default: 0 },
  amount: { type: Number, default: 0 },
}, { _id: false });

const itemLineSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 200 },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, trim: true, default: 'pcs' },
  unitPrice: { type: Number, required: true, min: 0 },
  amount: { type: Number, default: 0 },
}, { _id: false });

const expenseLineSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 200 },
  amount: { type: Number, required: true, min: 0 },
}, { _id: false });

const approvalSchema = new mongoose.Schema({
  level: { type: String, enum: ['branch_manager', 'owner'], required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
  comment: { type: String, maxlength: 1000 },
  at: Date,
}, { _id: false });

const trailSchema = new mongoose.Schema({
  action: String,
  byName: String,
  comment: String,
  at: { type: Date, default: Date.now },
}, { _id: false });

const branchReportSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  branchName: String,
  businessLine: String,
  department: { type: String, required: true, trim: true },
  referenceNumber: { type: String, required: true },
  reportDate: { type: Date, required: true },

  pumps: { type: [pumpLineSchema], default: [] },
  items: { type: [itemLineSchema], default: [] },
  collections: {
    cash: { type: Number, default: 0, min: 0 },
    pos: { type: Number, default: 0, min: 0 },
    transfer: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  expenses: { type: [expenseLineSchema], default: [] },
  notes: { type: String, maxlength: 2000 },

  // Computed on save (see pre-validate) — never trusted from the client.
  totals: {
    litres: { type: Number, default: 0 },
    expectedSales: { type: Number, default: 0 },
    collected: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
    variance: { type: Number, default: 0 }, // collected + expenses − expected; negative = shortage
  },

  status: {
    type: String,
    enum: ['draft', 'pending_branch', 'pending_owner', 'approved', 'rejected'],
    default: 'draft',
    index: true,
  },
  approvals: { type: [approvalSchema], default: [] },
  trail: { type: [trailSchema], default: [] },
  preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  preparedByName: String,
  submittedAt: Date,
  approvedAt: Date,
  ledgerNumber: String, // set on final approval — e.g. SL/2026/00042
  demo: { type: Boolean, default: false },
  shortageAlertedAt: { type: Date, default: null }, // owner/manager already pinged about this shortage
}, { timestamps: true });

branchReportSchema.index({ companyId: 1, reportDate: -1 });
branchReportSchema.index({ companyId: 1, status: 1, branchId: 1 });

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

branchReportSchema.pre('validate', function computeTotals(next) {
  let litres = 0;
  let expected = 0;
  this.pumps.forEach((p) => {
    p.litres = round2(Math.max(0, p.closingMeter - p.openingMeter));
    p.amount = round2(p.litres * p.pricePerLitre);
    litres += p.litres;
    expected += p.amount;
  });
  this.items.forEach((it) => {
    it.amount = round2(it.quantity * it.unitPrice);
    expected += it.amount;
  });
  const c = this.collections || {};
  const collected = (c.cash || 0) + (c.pos || 0) + (c.transfer || 0) + (c.credit || 0);
  const exp = this.expenses.reduce((s, e) => s + (e.amount || 0), 0);
  this.totals = {
    litres: round2(litres),
    expectedSales: round2(expected),
    collected: round2(collected),
    expenses: round2(exp),
    variance: round2(collected + exp - expected),
  };
  next();
});

module.exports = mongoose.model('BranchReport', branchReportSchema);
