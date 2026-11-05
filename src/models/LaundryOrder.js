'use strict';

const mongoose = require('mongoose');

// A laundry / dry-cleaning ticket: the clothes a customer drops off, what
// is to be done to each, and its journey from counter to collection.

const STATUSES = ['received', 'washing', 'ready', 'collected', 'cancelled'];

const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, enum: ['cash', 'transfer', 'pos_terminal'], required: true },
  note: { type: String, maxlength: 200 },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
});

const laundryOrderSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  ticketNumber: { type: String, required: true },
  customer: {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    address: { type: String, trim: true, maxlength: 300 },
  },
  items: [{
    item: { type: String, required: true },
    service: { type: String, required: true },
    unit: { type: String, default: 'piece' },
    quantity: { type: Number, required: true, min: 0.1 },
    price: { type: Number, required: true, min: 0 },
    // Colour/brand and stains or damage noted at the counter, so nobody
    // can later claim the shop caused them.
    description: { type: String, maxlength: 200 },
    condition: { type: String, maxlength: 200 },
  }],
  pieces: { type: Number, default: 0 },
  express: { type: Boolean, default: false },
  pickup: { type: Boolean, default: false },
  delivery: { type: Boolean, default: false },
  subtotal: { type: Number, default: 0 },
  expressCharge: { type: Number, default: 0 },
  pickupFee: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0 },
  payments: [paymentSchema],
  currency: { type: String, default: 'NGN' },
  dueAt: Date,
  status: { type: String, enum: STATUSES, default: 'received' },
  readyAt: Date,
  collectedAt: Date,
  readyNotifiedAt: Date,
  timeline: [{ status: String, note: String, at: { type: Date, default: Date.now }, byName: String }],
  notes: { type: String, maxlength: 1000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,
}, { timestamps: true });

laundryOrderSchema.virtual('balance').get(function balance() {
  return Math.max(0, Math.round(((this.total || 0) - (this.amountPaid || 0)) * 100) / 100);
});

laundryOrderSchema.index({ companyId: 1, ticketNumber: 1 }, { unique: true });
laundryOrderSchema.index({ companyId: 1, status: 1, dueAt: 1 });
laundryOrderSchema.index({ companyId: 1, createdAt: -1 });
laundryOrderSchema.index({ companyId: 1, 'customer.phone': 1 });
laundryOrderSchema.index({ companyId: 1, 'payments.at': 1 });

laundryOrderSchema.statics.STATUSES = STATUSES;
module.exports = mongoose.model('LaundryOrder', laundryOrderSchema);
