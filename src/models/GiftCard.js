'use strict';

const mongoose = require('mongoose');

const giftCardSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  code: { type: String, required: true, uppercase: true, trim: true }, // BIZLY-XXXX-XXXX-XXXX
  amount: { type: Number, required: true, min: 0 }, // original face value
  currency: { type: String, default: 'NGN' },
  balance: { type: Number, required: true, min: 0 }, // remaining, spendable value
  status: { type: String, enum: ['active', 'used', 'expired', 'cancelled'], default: 'active' },

  purchasedBy: {
    name: String,
    email: { type: String, trim: true, lowercase: true },
    phone: String,
  },
  sentTo: {
    name: String,
    email: { type: String, trim: true, lowercase: true },
    message: { type: String, maxlength: 200 },
  },
  // Snapshot of the MOST RECENT redemption, matching the spec's shape — the
  // full history (a balance can be spent across several orders) lives in
  // `redemptions` below.
  redeemedBy: {
    name: String,
    email: String,
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  },
  redemptions: [{
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    amount: Number,
    redeemedAt: { type: Date, default: Date.now },
  }],

  // Delivery to the recipient can be immediate or scheduled — sentAt is set
  // once the recipient email actually goes out (see giftCardController).
  scheduledSendAt: Date,
  sentAt: Date,

  expiresAt: { type: Date, required: true },
  purchasedAt: { type: Date, default: Date.now },
  redeemedAt: Date, // set once balance first reaches 0
  paystackReference: { type: String, unique: true, sparse: true },
}, { timestamps: true });

giftCardSchema.index({ companyId: 1, code: 1 }, { unique: true });
giftCardSchema.index({ companyId: 1, status: 1 });
giftCardSchema.index({ scheduledSendAt: 1, sentAt: 1 });

module.exports = mongoose.model('GiftCard', giftCardSchema);
