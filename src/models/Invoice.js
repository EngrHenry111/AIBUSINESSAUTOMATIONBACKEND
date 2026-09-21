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

  // ── Recurring invoices ────────────────────────────────────────────────
  // A recurring invoice IS a normal, usable invoice (the first occurrence)
  // that ALSO acts as an immutable template — the scheduler never edits its
  // line items, it only reads them to stamp out new child invoices. Child
  // invoices are plain invoices with isRecurring: false and
  // recurringParentId pointing back here.
  isRecurring: { type: Boolean, default: false },
  recurringParentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  recurringSettings: {
    interval: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'annually'], default: 'monthly' },
    nextDueDate: Date,
    lastGeneratedAt: Date,
    // Which child invoice the last cycle produced — lets the scheduler check
    // whether the customer actually paid the last one before blindly
    // generating another (see utils/recurringInvoices.js).
    lastGeneratedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    totalGenerated: { type: Number, default: 0 },
    maxOccurrences: Number, // null/undefined = unlimited
    endDate: Date, // null/undefined = no end date
    active: { type: Boolean, default: true },
    // Consecutive cycles whose previous invoice was still unpaid when the
    // next one came due — auto-pauses the schedule past a threshold instead
    // of silently piling up unpaid invoices on a non-paying customer.
    consecutiveUnpaid: { type: Number, default: 0 },
    pausedReason: String,
  },
}, { timestamps: true });

invoiceSchema.index({ companyId: 1, status: 1 });
invoiceSchema.index({ companyId: 1, dueAt: 1 });
invoiceSchema.index({ companyId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ isRecurring: 1, 'recurringSettings.active': 1, 'recurringSettings.nextDueDate': 1 });
invoiceSchema.index({ recurringParentId: 1 });

module.exports = mongoose.model('Invoice', invoiceSchema);