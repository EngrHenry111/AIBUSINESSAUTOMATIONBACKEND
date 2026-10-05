'use strict';

const mongoose = require('mongoose');

// What a term costs — e.g. "JSS 1 First Term 2026/2027": tuition, PTA levy,
// uniform… Generating it creates one FeeBill per student in its classes.
const feeStructureSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  session: { type: String, required: true, trim: true },
  term: { type: String, enum: ['first', 'second', 'third'], required: true },
  classIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' }], // empty = every class
  items: [{
    name: { type: String, required: true, trim: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    _id: false,
  }],
  dueDate: Date,
  // Students enrolled after the bills were generated get this bill too.
  autoApplyToNewStudents: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

feeStructureSchema.index({ companyId: 1, session: 1, term: 1 });

module.exports = mongoose.model('FeeStructure', feeStructureSchema);
