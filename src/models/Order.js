'use strict';

const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  orderNumber: { type: String, required: true },
  customer: { name: String, email: String, phone: String, address: String, city: String, state: String },
  source: { type: String, enum: ['manual', 'storefront'], default: 'manual' },
  paystackReference: { type: String },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    image: String,
    variant: String, // e.g. "Size: Large / Color: Red"
    quantity: Number,
    price: Number,
    sku: String,
  }],
  stockApplied: { type: Boolean, default: false },
  // ── Marketplace upgrade — checkout extras ──────────────────────────────
  subtotal: Number,
  deliveryFee: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  couponCode: String,
  loyaltyPointsUsed: { type: Number, default: 0 },
  loyaltyDiscount: { type: Number, default: 0 },
  giftCardCode: String,
  giftCardRedeemed: { type: Number, default: 0 },
  paymentMethod: {
    type: String,
    enum: ['paystack', 'pay_on_delivery', 'bank_transfer', 'split_payment'],
    default: 'paystack',
  },
  // Only meaningful when paymentMethod is 'split_payment' — the 50% paid at
  // checkout vs. the 50% collected on delivery.
  splitPayment: {
    firstAmount: Number,
    secondAmount: Number,
    secondPaidAt: Date,
  },
  bankTransferProof: String, // Cloudinary URL, customer-uploaded
  deliveryProof: String, // Cloudinary URL, uploaded when marking delivered
  // Guards loyalty-points awarding against double-crediting — a storefront
  // order can earn points at 'confirmed' (payment success) and later also
  // pass through 'delivered'; the retroactive migration endpoint re-runs
  // over the same orders too. See orderController.awardLoyaltyForOrder.
  pointsAwarded: { type: Boolean, default: false },
  total: Number,
  currency: { type: String, default: 'USD' },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
    default: 'pending',
  },
  paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'refunded'], default: 'unpaid' },
  trackingNumber: String,
  carrier: String,
  shippingAddress: { street: String, city: String, state: String, country: String, zip: String },
  estimatedDelivery: Date,
  deliveredAt: Date,
  timeline: [{
    status: String,
    description: String,
    timestamp: { type: Date, default: Date.now },
    location: String,
  }],
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

orderSchema.index({ companyId: 1, status: 1 });
orderSchema.index({ companyId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ companyId: 1, 'customer.email': 1 });
orderSchema.index({ paystackReference: 1 }, { unique: true, sparse: true });
orderSchema.index({ companyId: 1, source: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);