'use strict';

const mongoose = require('mongoose');

// A patient's bill. A visit (and any admission from it) runs one bill that
// charges are added to as services happen — consultation at check-in, lab
// tests when ordered, drugs when the pharmacy prices them, bed days at
// discharge. Walk-in lab tests and counter sales get a bill of their own.
//
// Money: total = subtotal - discount; an HMO pays coverPercent of the total
// (hmoAmount) and the patient the rest (patientAmount). `balance` is what
// the patient still owes — negative means the hospital owes a refund.
// Totals are recomputed by utils/hospital.recalcBill on every change.
const itemSchema = new mongoose.Schema({
  category: { type: String, enum: ['registration', 'consultation', 'nursing', 'procedure', 'lab', 'pharmacy', 'bed', 'other'], default: 'other' },
  description: { type: String, required: true, trim: true, maxlength: 200 },
  quantity: { type: Number, min: 0, default: 1 },
  unitPrice: { type: Number, min: 0, default: 0 },
  amount: { type: Number, min: 0, default: 0 },
  refType: { type: String, enum: ['lab', 'prescription', 'admission', 'service', null], default: null },
  refId: mongoose.Schema.Types.ObjectId,
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedAt: { type: Date, default: Date.now },
});

const hospitalBillSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  billNumber: { type: String, required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalVisit' },
  items: [itemSchema],
  subtotal: { type: Number, default: 0 },
  discount: { type: Number, min: 0, default: 0 },
  discountReason: { type: String, trim: true, maxlength: 200 },
  total: { type: Number, default: 0 },
  hmo: {
    name: String,
    enrolleeId: String,
    coverPercent: { type: Number, min: 0, max: 100 },
  },
  hmoAmount: { type: Number, default: 0 },
  patientAmount: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
  status: { type: String, enum: ['unpaid', 'partial', 'paid', 'cancelled'], default: 'paid' },
  claim: { // the HMO's share, claimed separately
    status: { type: String, enum: ['pending', 'submitted', 'paid', 'rejected'], default: 'pending' },
    submittedAt: Date,
    paidAt: Date,
    reference: { type: String, trim: true, maxlength: 80 },
    note: { type: String, trim: true, maxlength: 300 },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, optimisticConcurrency: true });

hospitalBillSchema.index({ companyId: 1, billNumber: 1 }, { unique: true });
hospitalBillSchema.index({ companyId: 1, patientId: 1, createdAt: -1 });
hospitalBillSchema.index({ companyId: 1, visitId: 1 });
hospitalBillSchema.index({ companyId: 1, status: 1, createdAt: -1 });
hospitalBillSchema.index({ companyId: 1, 'hmo.name': 1, createdAt: -1 });

module.exports = mongoose.model('HospitalBill', hospitalBillSchema);
