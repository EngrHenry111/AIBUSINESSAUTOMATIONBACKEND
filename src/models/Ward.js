'use strict';

const mongoose = require('mongoose');

// A ward and its beds. A bed's admissionId points at whoever is in it.
const bedSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 30 },
  status: { type: String, enum: ['available', 'occupied', 'cleaning', 'maintenance'], default: 'available' },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admission' },
});

const wardSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  type: { type: String, enum: ['general', 'male', 'female', 'children', 'maternity', 'icu', 'private', 'isolation', 'other'], default: 'general' },
  dailyRate: { type: Number, min: 0, default: 0 }, // bed charge per day
  beds: [bedSchema],
  active: { type: Boolean, default: true },
}, { timestamps: true });

wardSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Ward', wardSchema);
