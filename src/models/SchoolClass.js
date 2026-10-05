'use strict';

const mongoose = require('mongoose');

// A class/arm students are placed in, e.g. "JSS 1A" or "Primary 4 Gold".
// `level` orders classes for promotion (JSS 1 → JSS 2) and listings.
const schoolClassSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  level: { type: Number, default: 0 },
  section: { type: String, trim: true, maxlength: 60 }, // Nursery, Primary, Junior Secondary…
  classTeacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  subjects: [{ type: String, trim: true, maxlength: 100 }],
  capacity: { type: Number, min: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

schoolClassSchema.index({ companyId: 1, name: 1 }, { unique: true });
schoolClassSchema.index({ companyId: 1, level: 1 });

module.exports = mongoose.model('SchoolClass', schoolClassSchema);
