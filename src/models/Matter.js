'use strict';

const mongoose = require('mongoose');

// A legal matter (case/file) — the unit a law practice organises everything
// around: the client, the court, deadlines, billable time, client trust
// money and invoices all hang off a matter.

const PRACTICE_AREAS = [
  'litigation', 'corporate', 'commercial', 'property', 'family', 'criminal',
  'employment', 'intellectual_property', 'tax', 'banking_finance', 'energy',
  'immigration', 'arbitration', 'probate_estates', 'regulatory', 'other',
];

const partySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  role: { type: String, trim: true, maxlength: 100 },       // e.g. "Defendant", "Co-respondent"
  counsel: { type: String, trim: true, maxlength: 200 },    // their lawyer / firm
  contact: { type: String, trim: true, maxlength: 200 },
}, { _id: true });

const keyDateSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  type: {
    type: String,
    enum: ['hearing', 'filing_deadline', 'limitation', 'meeting', 'judgment', 'other'],
    default: 'other',
  },
  date: { type: Date, required: true },
  location: { type: String, trim: true, maxlength: 300 },
  notes: { type: String, trim: true, maxlength: 2000 },
  done: { type: Boolean, default: false },
  // Reminder bookkeeping for utils/matterReminders.js — one per window.
  reminded7d: { type: Boolean, default: false },
  reminded1d: { type: Boolean, default: false },
}, { _id: true, timestamps: true });

const matterSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  matterNumber: { type: String, required: true },
  title: { type: String, required: true, trim: true, maxlength: 300 },
  description: { type: String, trim: true, maxlength: 5000 },
  practiceArea: { type: String, enum: PRACTICE_AREAS, default: 'other' },
  status: { type: String, enum: ['open', 'pending', 'on_hold', 'closed'], default: 'open' },

  client: {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: ['individual', 'organization'], default: 'individual' },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true, maxlength: 400 },
  },

  court: {
    name: { type: String, trim: true, maxlength: 200 },        // "Federal High Court, Lagos"
    suitNumber: { type: String, trim: true, maxlength: 100 },  // "FHC/L/CS/123/2026"
    judge: { type: String, trim: true, maxlength: 200 },
    jurisdiction: { type: String, trim: true, maxlength: 200 },
  },
  opposingParties: [partySchema],
  relatedParties: [partySchema],

  responsibleLawyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  team: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  billing: {
    method: { type: String, enum: ['hourly', 'flat_fee', 'contingency', 'retainer', 'pro_bono'], default: 'hourly' },
    hourlyRate: { type: Number, min: 0, default: 0 },
    flatFee: { type: Number, min: 0 },
    contingencyPercent: { type: Number, min: 0, max: 100 },
    currency: { type: String, default: 'NGN' },
    budget: { type: Number, min: 0 },
  },

  keyDates: [keyDateSchema],

  // Running client-trust balance, mirrored from the TrustTransaction ledger.
  // Kept on the matter so a withdrawal can be checked-and-debited in ONE
  // atomic update ($gte guard) — two simultaneous withdrawals can never
  // overdraw the client's money.
  trustBalance: { type: Number, default: 0, min: 0 },

  // Recorded when the matter was opened — a firm must be able to show it
  // checked for conflicts of interest before taking the client on.
  conflictCheck: {
    checkedAt: Date,
    checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    result: { type: String, enum: ['clear', 'potential_conflict', 'waived'] },
    notes: { type: String, trim: true, maxlength: 2000 },
    hits: { type: Number, default: 0 },
  },

  tags: [{ type: String, trim: true, maxlength: 50 }],
  openedAt: { type: Date, default: Date.now },
  closedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

matterSchema.index({ companyId: 1, matterNumber: 1 }, { unique: true });
matterSchema.index({ companyId: 1, status: 1, updatedAt: -1 });
matterSchema.index({ companyId: 1, 'client.email': 1 });
matterSchema.index({ 'keyDates.date': 1, status: 1 });

matterSchema.statics.PRACTICE_AREAS = PRACTICE_AREAS;

module.exports = mongoose.model('Matter', matterSchema);
