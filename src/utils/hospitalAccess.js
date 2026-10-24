'use strict';

// Who can do what in the hospital module.
//
// req.hospital = { role, manager, department }
//   admin      — everything (owners/managers also get owner-only actions)
//   doctor     — patients, consultations, orders, admissions
//   nurse      — patients, check-in, triage/vitals, ward charts
//   pharmacist — prescriptions and drug stock
//   lab        — lab requests, results and the test menu
//   cashier    — bills and payments (no clinical notes)
//   records    — patient registration, check-in, appointments
// A team member without a hospital role has full access, so a new hospital
// works before the owner assigns roles.

const HospitalStaff = require('../models/HospitalStaff');
const { AppError } = require('../middleware/errorMiddleware');

const MANAGER_ROLES = ['manager', 'company_owner', 'super_admin'];

async function loadHospitalRole(req, res, next) {
  try {
    if (MANAGER_ROLES.includes(req.user.role)) {
      req.hospital = { role: 'admin', manager: true };
      return next();
    }
    const staff = await HospitalStaff.findOne({ companyId: req.companyId, userId: req.user._id }).select('role department').lean();
    req.hospital = { role: staff?.role || 'admin', manager: false, department: staff?.department };
    next();
  } catch (err) { next(err); }
}

// Route guard: allow('doctor', 'nurse'). Admins always pass.
const allow = (...roles) => (req, res, next) => {
  const role = req.hospital?.role;
  if (role === 'admin' || roles.includes(role)) return next();
  return next(new AppError('Your hospital role does not include this. Ask the hospital owner for access.', 403));
};

// Clinical notes, results and drugs are hidden from the cashier.
const seesClinical = (req) => req.hospital?.role !== 'cashier';

module.exports = { loadHospitalRole, allow, seesClinical, MANAGER_ROLES };
