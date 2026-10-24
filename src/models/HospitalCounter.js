'use strict';

const mongoose = require('mongoose');

// Atomic number sequences for the hospital module — patient, visit, bill,
// receipt, lab, prescription, admission numbers and each day's queue
// ("queue:2026-10-24"). $inc'd so two desks can never issue the same number.
const hospitalCounterSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

hospitalCounterSchema.index({ companyId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('HospitalCounter', hospitalCounterSchema);
