'use strict';

const mongoose = require('mongoose');

// Price lists and set-up for the Laundry and Cleaning industry modules,
// one document per company. Filled with sensible Nigerian defaults the
// first time it is read (see utils/serviceDefaults.js).

const laundryItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  category: { type: String, trim: true, maxlength: 40 },
  unit: { type: String, enum: ['piece', 'kg', 'pair', 'set'], default: 'piece' },
  // service name -> price. A service missing here isn't offered for the item.
  prices: { type: Map, of: Number, default: {} },
  active: { type: Boolean, default: true },
});

const cleaningServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300 },
  basePrice: { type: Number, min: 0, default: 0 },
  perBedroom: { type: Number, min: 0, default: 0 },
  perBathroom: { type: Number, min: 0, default: 0 },
  hours: { type: Number, min: 0.5, max: 48, default: 3 },
  checklist: { type: [String], default: [] },
  active: { type: Boolean, default: true },
});

const serviceSettingsSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  laundry: {
    services: { type: [String], default: undefined },
    items: { type: [laundryItemSchema], default: undefined },
    expressPercent: { type: Number, min: 0, max: 300, default: 50 },
    turnaroundDays: { type: Number, min: 0, max: 60, default: 3 },
    expressDays: { type: Number, min: 0, max: 30, default: 1 },
    pickupFee: { type: Number, min: 0, default: 0 },
    deliveryFee: { type: Number, min: 0, default: 0 },
    uncollectedDays: { type: Number, min: 1, max: 365, default: 30 },
  },
  cleaning: {
    services: { type: [cleaningServiceSchema], default: undefined },
    extras: { type: [{ name: { type: String, trim: true, maxlength: 80 }, price: { type: Number, min: 0 } }], default: undefined },
    transportFee: { type: Number, min: 0, default: 0 },
  },
}, { timestamps: true });

module.exports = mongoose.model('ServiceSettings', serviceSettingsSchema);
