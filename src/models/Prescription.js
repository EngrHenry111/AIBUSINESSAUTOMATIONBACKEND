'use strict';

const mongoose = require('mongoose');

// Drugs ordered by a doctor (or sold over the counter). The pharmacy prices
// it against stock (status billed — charges go on the patient's bill), then
// hands the drugs over (dispensed), which takes them out of stock.
const STATUSES = ['pending', 'billed', 'dispensed', 'cancelled'];

const rxItemSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyItem' }, // set when matched to stock
  drugName: { type: String, required: true, trim: true, maxlength: 200 },
  dose: { type: String, trim: true, maxlength: 60 }, // 1 tab, 10ml
  frequency: { type: String, trim: true, maxlength: 60 }, // bd, tds, nocte…
  route: { type: String, trim: true, maxlength: 30 }, // oral, IV, IM…
  duration: { type: String, trim: true, maxlength: 60 }, // 5 days
  quantity: { type: Number, min: 0, default: 0 }, // units to hand over
  instructions: { type: String, trim: true, maxlength: 300 },
  unitPrice: { type: Number, min: 0, default: 0 },
  amount: { type: Number, min: 0, default: 0 },
  // not_available: out of stock here — the patient buys it elsewhere.
  status: { type: String, enum: ['pending', 'billed', 'dispensed', 'not_available'], default: 'pending' },
});

const prescriptionSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  rxNumber: { type: String, required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalVisit' },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admission' },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalBill' },
  items: [rxItemSchema],
  notes: { type: String, trim: true, maxlength: 1000 },
  status: { type: String, enum: STATUSES, default: 'pending' },
  source: { type: String, enum: ['doctor', 'counter'], default: 'doctor' },
  prescribedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  billedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  billedAt: Date,
  dispensedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispensedAt: Date,
}, { timestamps: true });

prescriptionSchema.index({ companyId: 1, rxNumber: 1 }, { unique: true });
prescriptionSchema.index({ companyId: 1, status: 1, createdAt: -1 });
prescriptionSchema.index({ companyId: 1, patientId: 1, createdAt: -1 });
prescriptionSchema.index({ companyId: 1, visitId: 1 });
prescriptionSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('Prescription', prescriptionSchema);
