'use strict';

const mongoose = require('mongoose');

// Tests ordered for a patient: requested → sample collected → results in
// (completed) → verified. Each test carries a copy of its parameters at the
// time of ordering, so later edits to the menu don't change old reports.
const STATUSES = ['requested', 'collected', 'completed', 'cancelled'];

const resultSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 80 },
  value: { type: String, trim: true, maxlength: 120 },
  unit: { type: String, trim: true, maxlength: 30 },
  refLow: Number,
  refHigh: Number,
  refText: { type: String, trim: true, maxlength: 80 },
  flag: { type: String, enum: ['', 'L', 'H'], default: '' },
}, { _id: false });

const requestedTestSchema = new mongoose.Schema({
  testId: { type: mongoose.Schema.Types.ObjectId, ref: 'LabTest' },
  name: { type: String, required: true, trim: true },
  category: String,
  sampleType: String,
  price: { type: Number, min: 0, default: 0 },
  results: [resultSchema],
  comment: { type: String, trim: true, maxlength: 1000 },
  done: { type: Boolean, default: false },
});

const labRequestSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  labNumber: { type: String, required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalVisit' },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admission' },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalBill' },
  tests: [requestedTestSchema],
  priority: { type: String, enum: ['routine', 'urgent'], default: 'routine' },
  clinicalNotes: { type: String, trim: true, maxlength: 1000 },
  status: { type: String, enum: STATUSES, default: 'requested' },
  source: { type: String, enum: ['doctor', 'walk_in'], default: 'doctor' },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  collectedAt: Date,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date,
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
}, { timestamps: true });

labRequestSchema.index({ companyId: 1, labNumber: 1 }, { unique: true });
labRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 });
labRequestSchema.index({ companyId: 1, patientId: 1, createdAt: -1 });
labRequestSchema.index({ companyId: 1, visitId: 1 });
labRequestSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('LabRequest', labRequestSchema);
