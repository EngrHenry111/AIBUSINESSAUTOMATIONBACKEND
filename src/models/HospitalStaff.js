'use strict';

const mongoose = require('mongoose');

// A team member's role in the hospital module (utils/hospitalAccess.js).
// No record = full access, so existing team members keep working until the
// owner assigns roles.
const ROLES = ['admin', 'doctor', 'nurse', 'pharmacist', 'lab', 'cashier', 'records'];

const hospitalStaffSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ROLES, required: true },
  department: { type: String, trim: true, maxlength: 120 },
  title: { type: String, trim: true, maxlength: 60 }, // Dr., Consultant, Matron…
}, { timestamps: true });

hospitalStaffSchema.index({ companyId: 1, userId: 1 }, { unique: true });
hospitalStaffSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('HospitalStaff', hospitalStaffSchema);
