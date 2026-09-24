'use strict';

const mongoose = require('mongoose');

// A recurring "box" a store owner sells — e.g. "Weekly Veg Box". Customers
// subscribe to one of these (see StoreSubscription, the per-customer record
// this template spawns at signup).
const subscriptionPlanSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 1000 },
  image: String,
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: String,
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
  }],
  interval: {
    type: String,
    enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'],
    default: 'monthly',
  },
  price: { type: Number, required: true, min: 0 },
  originalPrice: { type: Number, min: 0 }, // shown struck-through when higher than price
  deliveryFee: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  subscriberCount: { type: Number, default: 0 },
  trialDays: { type: Number, default: 0, min: 0 },
  maxSubscribers: { type: Number, default: null }, // null = unlimited
  perks: [{ type: String, trim: true, maxlength: 80 }],
}, { timestamps: true });

subscriptionPlanSchema.index({ companyId: 1, isActive: 1 });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
