'use strict';

const mongoose = require('mongoose');

// An inpatient stay. `stays` records each ward/bed the patient was in and
// its daily rate, so a transfer from the general ward to ICU bills both
// correctly at discharge. `chart` is the nursing record: observations,
// notes and drugs given.
const staySchema = new mongoose.Schema({
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  wardName: String,
  bedId: mongoose.Schema.Types.ObjectId,
  bedLabel: String,
  dailyRate: { type: Number, default: 0 },
  from: { type: Date, default: Date.now },
  to: Date,
}, { _id: false });

const chartEntrySchema = new mongoose.Schema({
  kind: { type: String, enum: ['vitals', 'note', 'medication', 'doctor'], required: true },
  vitals: {
    systolic: Number, diastolic: Number, temperature: Number, pulse: Number,
    respiration: Number, spo2: Number, glucose: Number, painScore: Number,
  },
  text: { type: String, trim: true, maxlength: 3000 },
  drug: { type: String, trim: true, maxlength: 200 },
  dose: { type: String, trim: true, maxlength: 60 },
  route: { type: String, trim: true, maxlength: 30 },
  intake: Number, // ml (fluid chart)
  output: Number, // ml
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now },
});

const admissionSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  admissionNumber: { type: String, required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalVisit' },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalBill' },
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' }, // current ward
  bedId: mongoose.Schema.Types.ObjectId,
  bedLabel: String,
  stays: [staySchema],
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // admitting / responsible doctor
  reason: { type: String, trim: true, maxlength: 1000 },
  diagnosis: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ['admitted', 'discharged'], default: 'admitted' },
  admittedAt: { type: Date, default: Date.now },
  admittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  chart: [chartEntrySchema],
  discharge: {
    at: Date,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    outcome: { type: String, enum: ['improved', 'recovered', 'referred', 'against_advice', 'deceased', 'other'] },
    summary: { type: String, trim: true, maxlength: 5000 },
    instructions: { type: String, trim: true, maxlength: 2000 },
    followUpDate: Date,
    bedDays: Number,
    bedCharge: Number,
  },
}, { timestamps: true });

admissionSchema.index({ companyId: 1, admissionNumber: 1 }, { unique: true });
admissionSchema.index({ companyId: 1, status: 1, admittedAt: -1 });
admissionSchema.index({ companyId: 1, patientId: 1, admittedAt: -1 });

module.exports = mongoose.model('Admission', admissionSchema);
