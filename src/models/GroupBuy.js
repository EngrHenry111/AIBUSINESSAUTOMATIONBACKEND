'use strict';

const mongoose = require('mongoose');

// A store owner's "get N people to buy together, everyone saves" deal.
// Participant payment is captured immediately on join (see groupBuyController
// — Paystack has no hold/pre-auth primitive for a standard transaction) and
// refunded in full via a real Paystack refund if the deal fails to reach its
// minimum by the deadline.
const groupBuySchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: String,
  productImage: String,

  title: { type: String, required: true, trim: true, maxlength: 150 },
  description: { type: String, trim: true, maxlength: 1000 },

  originalPrice: { type: Number, required: true, min: 0 },
  groupPrice: { type: Number, required: true, min: 0 },
  discountPercent: { type: Number, default: 0 },

  minimumParticipants: { type: Number, required: true, min: 2 },
  maximumParticipants: { type: Number, default: null }, // null = unlimited
  currentParticipants: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['active', 'successful', 'failed', 'cancelled', 'expired'],
    default: 'active',
  },

  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },

  participants: [{
    name: String,
    email: String,
    phone: String,
    quantity: { type: Number, default: 1 },
    amount: Number,
    paymentStatus: { type: String, enum: ['pending', 'paid', 'refunded', 'failed'], default: 'pending' },
    paystackReference: String,
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    joinedAt: { type: Date, default: Date.now },
  }],

  totalValue: { type: Number, default: 0 },
  shareLink: String,
  shareCode: { type: String, required: true }, // GB-XXXX

  successfulAt: Date,
  failedAt: Date,
  cancelledAt: Date,
}, { timestamps: true });

groupBuySchema.index({ companyId: 1, status: 1 });
groupBuySchema.index({ companyId: 1, shareCode: 1 }, { unique: true });
groupBuySchema.index({ status: 1, endDate: 1 });

module.exports = mongoose.model('GroupBuy', groupBuySchema);
