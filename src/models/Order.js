'use strict';

const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  orderNumber: { type: String, required: true },
  customer: { name: String, email: String, phone: String },
  items: [{ name: String, quantity: Number, price: Number, sku: String }],
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

module.exports = mongoose.model('Order', orderSchema);