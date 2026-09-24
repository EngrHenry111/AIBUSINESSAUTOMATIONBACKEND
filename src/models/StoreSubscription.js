'use strict';

const mongoose = require('mongoose');

// One customer's live subscription to a SubscriptionPlan. Item/price fields
// are snapshotted from the plan at signup time — later edits to the plan
// (price change, item swap) never retroactively change what an existing
// subscriber is being charged.
const storeSubscriptionSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreCustomer', required: true },
  customerEmail: { type: String, required: true, trim: true, lowercase: true },
  customerName: String,
  customerPhone: String,
  customerAddress: String,
  name: { type: String, required: true }, // plan name at signup, e.g. "Weekly Food Box"
  description: String,
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    image: String,
    quantity: Number,
    unitPrice: Number,
    total: Number,
  }],
  subtotal: Number,
  deliveryFee: { type: Number, default: 0 },
  total: Number,
  currency: { type: String, default: 'NGN' },
  interval: {
    type: String,
    enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'],
    default: 'monthly',
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'cancelled', 'expired'],
    default: 'active',
  },
  paymentMethod: { type: String, enum: ['paystack', 'pay_on_delivery'], default: 'paystack' },
  paystackSubscriptionCode: String,
  // Captured from the first successful charge (transaction.verify's
  // `authorization.authorization_code`) — reused for every later renewal via
  // POST /transaction/charge_authorization. Never set for pay_on_delivery.
  paystackAuthorizationCode: String,
  startDate: { type: Date, required: true },
  nextDeliveryDate: { type: Date, required: true },
  lastDeliveryDate: Date,
  endDate: { type: Date, default: null }, // null = no end
  totalDeliveries: { type: Number, default: 0 },
  maxDeliveries: { type: Number, default: null }, // null = unlimited
  deliveryHistory: [{
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    deliveryDate: Date,
    status: { type: String, enum: ['created', 'failed'], default: 'created' },
    amount: Number,
  }],
  // Consecutive failed Paystack renewal attempts — reset to 0 on any
  // successful charge. Auto-cancelled at 3 (see storeSubscriptionProcessor).
  failedAttempts: { type: Number, default: 0 },
  lastFailedAt: Date,
  pausedAt: Date,
  cancelledAt: Date,
  cancellationReason: String,
}, { timestamps: true });

storeSubscriptionSchema.index({ companyId: 1, status: 1 });
storeSubscriptionSchema.index({ status: 1, nextDeliveryDate: 1 });
storeSubscriptionSchema.index({ customerId: 1 });

module.exports = mongoose.model('StoreSubscription', storeSubscriptionSchema);
