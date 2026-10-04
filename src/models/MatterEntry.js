'use strict';

const mongoose = require('mongoose');

// A billable line on a matter: either time worked or a disbursement
// (filing fees, travel, courier…). Unbilled entries are rolled into an
// invoice by matterController.invoiceMatter, which stamps invoiceId so the
// same work can never be billed twice.
const matterEntrySchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  matterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Matter', required: true },
  kind: { type: String, enum: ['time', 'expense'], required: true },
  date: { type: Date, required: true, default: Date.now },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // time
  minutes: { type: Number, min: 0, max: 24 * 60 },
  rate: { type: Number, min: 0 },               // per hour, snapshotted when logged

  // expense
  quantity: { type: Number, min: 0, default: 1 },
  unitCost: { type: Number, min: 0 },

  amount: { type: Number, required: true, min: 0 }, // computed on save
  billable: { type: Boolean, default: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
}, { timestamps: true });

matterEntrySchema.pre('validate', function computeAmount(next) {
  if (this.kind === 'time') {
    this.amount = Math.round(((this.minutes || 0) / 60) * (this.rate || 0) * 100) / 100;
  } else {
    this.amount = Math.round((this.quantity ?? 1) * (this.unitCost || 0) * 100) / 100;
  }
  next();
});

matterEntrySchema.index({ companyId: 1, matterId: 1, date: -1 });
matterEntrySchema.index({ companyId: 1, matterId: 1, invoiceId: 1, billable: 1 });
matterEntrySchema.index({ companyId: 1, userId: 1, date: -1 });

module.exports = mongoose.model('MatterEntry', matterEntrySchema);
