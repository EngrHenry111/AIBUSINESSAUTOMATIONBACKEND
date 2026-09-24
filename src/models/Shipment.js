'use strict';

const mongoose = require('mongoose');

const shipmentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },

  provider: {
    type: String,
    enum: ['gig', 'kwik', 'sendbox', 'dhl', 'fedex', 'manual', 'other'],
    default: 'manual',
  },
  providerName: String,
  trackingNumber: { type: String, required: true },
  trackingUrl: String,

  status: {
    type: String,
    enum: ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'],
    default: 'pending',
  },

  sender: { name: String, phone: String, address: String, city: String, state: String },
  recipient: { name: String, phone: String, address: String, city: String, state: String },

  weight: Number, // kg
  dimensions: { length: Number, width: Number, height: Number },

  deliveryFee: Number,
  estimatedDelivery: Date,
  deliveredAt: Date,

  trackingHistory: [{
    status: String,
    location: String,
    timestamp: { type: Date, default: Date.now },
    description: String,
  }],

  lastTrackedAt: Date,
  providerShipmentId: String, // the provider's own id/code for this shipment, used to match webhooks
  notes: String,
}, { timestamps: true });

shipmentSchema.index({ companyId: 1, status: 1 });
shipmentSchema.index({ orderId: 1 }, { unique: true });
// Tracking numbers are looked up publicly with no companyId to scope by
// (see deliveryController.trackShipment), so this must be globally unique.
shipmentSchema.index({ trackingNumber: 1 }, { unique: true });
shipmentSchema.index({ provider: 1, providerShipmentId: 1 });

module.exports = mongoose.model('Shipment', shipmentSchema);
