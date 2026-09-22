'use strict';

const mongoose = require('mongoose');

const partySchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  address: { type: String, trim: true },
  role: { type: String, trim: true }, // "Service Provider", "Client", "Employer", "Employee" etc
}, { _id: false });

const contractSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  type: {
    type: String,
    enum: [
      'service_agreement', 'employment', 'nda', 'vendor', 'freelance',
      'partnership', 'lease', 'sale_of_goods', 'consulting', 'retainer', 'custom',
    ],
    required: true,
  },
  status: {
    type: String,
    enum: ['draft', 'sent', 'signed', 'expired', 'cancelled'],
    default: 'draft',
  },
  parties: {
    party1: partySchema,
    party2: partySchema,
  },
  terms: {
    startDate: Date,
    endDate: Date,
    value: Number,
    currency: { type: String, default: 'NGN' },
    paymentTerms: String,
    deliverables: String,
    governingLaw: { type: String, default: 'Federal Republic of Nigeria' },
  },
  content: { type: String, default: '' }, // Full contract text, edited in place
  aiGenerated: { type: Boolean, default: true },
  customClauses: { type: [String], default: [] },
  sentAt: Date,
  signedAt: Date,
  expiresAt: Date,
  linkedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  linkedLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

contractSchema.index({ companyId: 1, status: 1 });
contractSchema.index({ companyId: 1, type: 1 });
contractSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('Contract', contractSchema);
