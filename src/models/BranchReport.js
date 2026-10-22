'use strict';

const mongoose = require('mongoose');

// A department's sales report. It moves through two approvals — branch
// manager, then the group owner — and only once the owner approves does it
// get a ledger number and count in the final approved sales.
//
// Forecourt reports are per attendant per shift: one line per nozzle, each
// with its own meter readings and its own cash / POS / transfer takings, so
// a shortage can be traced to a person, a nozzle and a shift.
const pumpLineSchema = new mongoose.Schema({
  pump: { type: String, required: true, trim: true },   // e.g. "Pump 2"
  nozzle: { type: String, trim: true, default: '' },    // e.g. "P2-N1"
  attendant: { type: String, trim: true, maxlength: 120, default: '' }, // who handled this nozzle on the shift
  product: { type: String, enum: ['PMS', 'AGO', 'DPK', 'LPG'], default: 'PMS' },
  openingMeter: { type: Number, required: true, min: 0 },
  closingMeter: { type: Number, required: true, min: 0 },
  pumpTest: { type: Number, default: 0, min: 0 },       // litres dispensed for calibration and returned to tank
  pricePerLitre: { type: Number, required: true, min: 0 },
  cash: { type: Number, default: 0, min: 0 },
  pos: { type: Number, default: 0, min: 0 },
  transfer: { type: Number, default: 0, min: 0 },
  // Computed
  litres: { type: Number, default: 0 },
  amount: { type: Number, default: 0 },
  variance: { type: Number, default: 0 },
  prevClosing: { type: Number, default: null },         // previous shift's closing on this nozzle
  meterGap: { type: Number, default: 0 },               // opening − prevClosing; ≠ 0 means unrecorded or reversed litres
}, { _id: false });

const transferSchema = new mongoose.Schema({
  sender: { type: String, trim: true, maxlength: 120 },
  bank: { type: String, trim: true, maxlength: 80 },
  reference: { type: String, trim: true, maxlength: 80 },
  nozzle: { type: String, trim: true, maxlength: 20 },
  amount: { type: Number, required: true, min: 0 },
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
  paidBy: { type: String, trim: true, maxlength: 120, default: '' }, // attendant whose cash paid it
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
  shift: {
    name: { type: String, trim: true, maxlength: 40 },
    start: { type: String, trim: true, maxlength: 5 },   // "06:00"
    end: { type: String, trim: true, maxlength: 5 },     // "14:00"
  },
  attendantName: { type: String, trim: true, maxlength: 120 },
  attendantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  onDuty: { type: [{ type: String, trim: true, maxlength: 120 }], default: [] }, // others who sold on this shift
  // Computed: everyone who sold on this report (nozzle attendants, or the
  // report-level sales person). Used for listing and filtering by person.
  attendants: { type: [String], default: [] },

  pumps: { type: [pumpLineSchema], default: [] },
  items: { type: [itemLineSchema], default: [] },
  collections: {
    cash: { type: Number, default: 0, min: 0 },
    pos: { type: Number, default: 0, min: 0 },
    transfer: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  expenses: { type: [expenseLineSchema], default: [] },
  transfers: { type: [transferSchema], default: [] },     // itemised bank transfers, for checking against bank alerts
  notes: { type: String, maxlength: 2000 },

  // Computed on save (see pre-validate) — never trusted from the client.
  totals: {
    litres: { type: Number, default: 0 },
    expectedSales: { type: Number, default: 0 },
    collected: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
    variance: { type: Number, default: 0 }, // collected + expenses − expected; negative = shortage
    pumpTest: { type: Number, default: 0 },
    meterGapLitres: { type: Number, default: 0 }, // sum of |meterGap| across nozzles
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
  shortageAlertedAt: { type: Date, default: null }, // owner/manager already pinged about this shortage
}, { timestamps: true });

branchReportSchema.index({ companyId: 1, reportDate: -1 });
branchReportSchema.index({ companyId: 1, status: 1, branchId: 1 });
branchReportSchema.index({ branchId: 1, 'pumps.nozzle': 1, reportDate: -1 });

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

branchReportSchema.pre('validate', function computeTotals(next) {
  // A nozzle with no attendant of its own was handled by the sheet's default attendant.
  const fallback = String(this.attendantName || '').trim();
  this.pumps.forEach((p) => { if (!String(p.attendant || '').trim() && fallback) p.attendant = fallback; });
  const names = this.pumps.length ? this.pumps.map((p) => String(p.attendant || '').trim()) : [fallback];
  this.attendants = [...new Set(names.filter(Boolean))];
  if (!fallback && this.attendants.length === 1) this.attendantName = this.attendants[0];

  let litres = 0;
  let expected = 0;
  let pumpTest = 0;
  let gap = 0;
  this.pumps.forEach((p) => {
    p.litres = round2(Math.max(0, p.closingMeter - p.openingMeter - (p.pumpTest || 0)));
    p.amount = round2(p.litres * p.pricePerLitre);
    p.variance = round2((p.cash || 0) + (p.pos || 0) + (p.transfer || 0) - p.amount);
    litres += p.litres;
    expected += p.amount;
    pumpTest += p.pumpTest || 0;
    gap += Math.abs(p.meterGap || 0);
  });
  this.items.forEach((it) => {
    it.amount = round2(it.quantity * it.unitPrice);
    expected += it.amount;
  });
  // When takings are recorded per nozzle, the nozzle lines are the source of
  // truth for cash/POS/transfer; credit sales stay at report level.
  if (this.pumps.some((p) => p.cash || p.pos || p.transfer)) {
    this.collections = {
      ...(this.collections?.toObject?.() || this.collections || {}),
      cash: round2(this.pumps.reduce((s, p) => s + (p.cash || 0), 0)),
      pos: round2(this.pumps.reduce((s, p) => s + (p.pos || 0), 0)),
      transfer: round2(this.pumps.reduce((s, p) => s + (p.transfer || 0), 0)),
    };
  }
  const c = this.collections || {};
  const collected = (c.cash || 0) + (c.pos || 0) + (c.transfer || 0) + (c.credit || 0);
  const exp = this.expenses.reduce((s, e) => s + (e.amount || 0), 0);
  this.totals = {
    litres: round2(litres),
    expectedSales: round2(expected),
    collected: round2(collected),
    expenses: round2(exp),
    variance: round2(collected + exp - expected),
    pumpTest: round2(pumpTest),
    meterGapLitres: round2(gap),
  };
  next();
});

module.exports = mongoose.model('BranchReport', branchReportSchema);
