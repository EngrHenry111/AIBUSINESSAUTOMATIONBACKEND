'use strict';

const mongoose = require('mongoose');

// One document per (companyId, sessionId) — upserted every time the shopper's
// cart changes on the checkout page, so it always reflects their latest cart
// rather than the moment they first typed their email. Auto-deleted 14 days
// after the last update via the TTL index below, whether or not it was ever
// recovered — no point reminding someone about a month-old cart.
const abandonedCartSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  sessionId: { type: String, required: true },
  customer: {
    name: String,
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: String,
  },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    image: String,
    price: Number,
    quantity: Number,
    variantGroup: String,
    variantValue: String,
  }],
  total: { type: Number, default: 0 },
  recovered: { type: Boolean, default: false },
  recoveredAt: Date,
  remindersSent: { type: Number, default: 0 },
  lastReminderAt: Date,
  expiresAt: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

abandonedCartSchema.index({ companyId: 1, sessionId: 1 }, { unique: true });
abandonedCartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AbandonedCart', abandonedCartSchema);
