'use strict';

const mongoose = require('mongoose');

// A team member's job in the school module. Owners/managers always have
// full access; an employee with no record here keeps full access too (so
// existing teams aren't locked out) until the owner gives them a role.
//   admin   — everything except owner-only actions
//   bursar  — fees and students; no admissions decisions or results
//   teacher — only their own classes: register, scores, report comments
const schoolStaffSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['admin', 'bursar', 'teacher'], required: true },
}, { timestamps: true });

schoolStaffSchema.index({ companyId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('SchoolStaff', schoolStaffSchema);
