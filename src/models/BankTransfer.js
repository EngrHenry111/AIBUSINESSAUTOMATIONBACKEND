'use strict';

const mongoose = require('mongoose');

// Every transfer received into a dedicated account, and where its money
// went. `creditRemaining` is the part not yet applied to any bill; it only
// ever moves through atomic $inc updates, so the webhook and a bursar
// clicking "apply credit" can never spend the same naira twice.
const bankTransferSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  reference: { type: String, required: true, unique: true }, // Paystack reference
  amount: { type: Number, required: true },
  currency: { type: String, default: 'NGN' },
  paidAt: { type: Date, default: Date.now },
  senderName: String,
  senderBank: String,
  senderAccount: String, // masked by Paystack
  narration: String,
  virtualAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount' },
  accountNumber: String,
  ownerType: { type: String, enum: ['student'] },
  ownerId: { type: mongoose.Schema.Types.ObjectId },
  allocations: [{
    kind: { type: String, enum: ['fee_bill'] },
    billId: { type: mongoose.Schema.Types.ObjectId },
    billNumber: String,
    paymentId: { type: mongoose.Schema.Types.ObjectId },
    amount: Number,
    at: { type: Date, default: Date.now },
    by: { type: String, enum: ['auto', 'staff'], default: 'auto' },
    _id: false,
  }],
  creditRemaining: { type: Number, default: 0 },
  status: { type: String, enum: ['processing', 'applied', 'partially_applied', 'credit'], default: 'processing' },
}, { timestamps: true });

bankTransferSchema.index({ companyId: 1, paidAt: -1 });
bankTransferSchema.index({ companyId: 1, ownerType: 1, ownerId: 1, paidAt: -1 });
bankTransferSchema.index({ companyId: 1, creditRemaining: 1 });

module.exports = mongoose.model('BankTransfer', bankTransferSchema);
