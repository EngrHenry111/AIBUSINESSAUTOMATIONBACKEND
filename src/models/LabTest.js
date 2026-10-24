'use strict';

const mongoose = require('mongoose');

// The lab's test menu. `parameters` are the result lines a scientist fills
// in (FBC → Hb, WBC, Platelets…); numeric low/high ranges let results be
// flagged automatically.
const parameterSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  unit: { type: String, trim: true, maxlength: 30 },
  refLow: Number,
  refHigh: Number,
  refText: { type: String, trim: true, maxlength: 80 }, // "Negative", "Not seen"…
}, { _id: false });

const labTestSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  code: { type: String, trim: true, uppercase: true, maxlength: 20 },
  category: { type: String, trim: true, maxlength: 60, default: 'General' }, // Haematology, Chemistry…
  sampleType: { type: String, trim: true, maxlength: 60 }, // Blood (EDTA), Urine, Stool…
  price: { type: Number, min: 0, default: 0 },
  turnaroundHours: { type: Number, min: 0 },
  parameters: { type: [parameterSchema], default: [] },
  active: { type: Boolean, default: true },
}, { timestamps: true });

labTestSchema.index({ companyId: 1, name: 1 }, { unique: true });
labTestSchema.index({ companyId: 1, category: 1, name: 1 });

module.exports = mongoose.model('LabTest', labTestSchema);
