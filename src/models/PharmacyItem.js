'use strict';

const mongoose = require('mongoose');

// A drug or consumable the pharmacy stocks. Stock is held in batches with
// expiry dates and dispensed first-expiry-first-out; `stock` is the total
// across batches, kept in step by utils/hospitalPharmacy.js.
const batchSchema = new mongoose.Schema({
  batchNo: { type: String, trim: true, maxlength: 60 },
  expiresAt: Date,
  quantity: { type: Number, min: 0, default: 0 },
  receivedAt: { type: Date, default: Date.now },
});

const pharmacyItemSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 160 }, // brand or common name
  genericName: { type: String, trim: true, maxlength: 160 },
  form: { type: String, enum: ['tablet', 'capsule', 'syrup', 'suspension', 'injection', 'infusion', 'cream', 'drops', 'inhaler', 'suppository', 'consumable', 'other'], default: 'tablet' },
  strength: { type: String, trim: true, maxlength: 60 }, // 500mg, 5mg/5ml…
  unit: { type: String, trim: true, maxlength: 30, default: 'tab' }, // what one quantity is: tab, bottle, vial…
  sellingPrice: { type: Number, min: 0, default: 0 }, // per unit
  costPrice: { type: Number, min: 0, default: 0 },
  stock: { type: Number, default: 0 },
  reorderLevel: { type: Number, min: 0, default: 10 },
  batches: [batchSchema],
  active: { type: Boolean, default: true },
}, { timestamps: true, optimisticConcurrency: true });

pharmacyItemSchema.index({ companyId: 1, name: 1, strength: 1, form: 1 }, { unique: true });
pharmacyItemSchema.index({ companyId: 1, active: 1, name: 1 });

module.exports = mongoose.model('PharmacyItem', pharmacyItemSchema);
