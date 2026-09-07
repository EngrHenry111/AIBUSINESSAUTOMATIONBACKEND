'use strict';

const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  invoiceNumber: { type: String, required: true },
  customer: {
    name: { type: String, required: true },
    email: { type: String },
    phone: { type: String },
    address: String,
  },
  items: [{
    description: String,
    quantity: { type: Number, default: 1 },
    unitPrice: Number,
    total: Number,
  }],
  subtotal: { type: Number, required: true },
  tax: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  total: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  status: {
    type: String,
    enum: ['draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'cancelled'],
    default: 'draft',
  },
  issuedAt: { type: Date, default: Date.now },
  dueAt: { type: Date, required: true },
  paidAt: { type: Date },
  sentAt: { type: Date },
  receiptSentAt: { type: Date },
  notes: String,
  reminders: [{
    sentAt: Date,
    method: { type: String, enum: ['email', 'whatsapp', 'sms'] },
    aiGenerated: { type: Boolean, default: false },
    messagePreview: String,
  }],
  ai: {
    reminderDraft: String,
    agingStatus: String,
    recommendedAction: String,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

invoiceSchema.index({ companyId: 1, status: 1 });
invoiceSchema.index({ companyId: 1, dueAt: 1 });
invoiceSchema.index({ companyId: 1, invoiceNumber: 1 }, { unique: true });

module.exports = mongoose.model('Invoice', invoiceSchema);