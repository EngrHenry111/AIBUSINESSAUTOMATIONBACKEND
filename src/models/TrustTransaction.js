'use strict';

const mongoose = require('mongoose');

// Client trust (escrow / client account) ledger. Money a client deposits
// with the firm is NOT the firm's money until it's applied to an invoice —
// professional rules almost everywhere require it to be tracked per client
// matter and never overdrawn. Entries are append-only: a mistake is fixed
// with a reversing entry, never an edit, so the ledger stays auditable.
const trustTransactionSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  matterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Matter', required: true },
  type: {
    type: String,
    // deposit:            client pays money into trust          (+)
    // invoice_payment:    trust applied to one of our invoices  (−)
    // disbursement:       paid out on the client's behalf       (−)
    // refund:             returned to the client                (−)
    enum: ['deposit', 'invoice_payment', 'disbursement', 'refund'],
    required: true,
  },
  amount: { type: Number, required: true, min: 0.01 },  // always positive; sign comes from type
  currency: { type: String, default: 'NGN' },
  date: { type: Date, default: Date.now },
  description: { type: String, trim: true, maxlength: 500 },
  reference: { type: String, trim: true, maxlength: 100 }, // bank ref / cheque no.
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  balanceAfter: { type: Number, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

trustTransactionSchema.index({ companyId: 1, matterId: 1, createdAt: 1 });

trustTransactionSchema.statics.signed = (t) => (t.type === 'deposit' ? t.amount : -t.amount);

module.exports = mongoose.model('TrustTransaction', trustTransactionSchema);
