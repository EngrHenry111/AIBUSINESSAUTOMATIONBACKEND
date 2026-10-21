'use strict';

const mongoose = require('mongoose');

// A physical location of a multi-site business (a filling station, a
// building-materials outlet, …). One Company = the owner's whole group;
// branches are the sites under it, each with its own departments, manager
// and staff. Access to a branch's reports is derived from managerId/staff —
// the User model is left untouched.
const departmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  headId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
});

const nozzleSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, maxlength: 20 },  // "P1-N1"
  pump: { type: String, required: true, trim: true, maxlength: 40 },  // "Pump 1"
  product: { type: String, enum: ['PMS', 'AGO', 'DPK', 'LPG'], default: 'PMS' },
}, { _id: false });

const shiftSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  start: { type: String, required: true, trim: true, maxlength: 5 },
  end: { type: String, required: true, trim: true, maxlength: 5 },
}, { _id: false });

const DEFAULT_SHIFTS = [
  { name: 'Morning', start: '06:00', end: '12:00' },
  { name: 'Afternoon', start: '12:00', end: '18:00' },
  { name: 'Evening', start: '18:00', end: '22:00' },
];

// Branch staff who sell but never log in (pump attendants, sales reps,
// cashiers). Reports filed by the few app users record which of them was
// on duty, so every naira is still tied to a named person.
const dutyStaffSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  role: { type: String, trim: true, maxlength: 60, default: '' },
  phone: { type: String, trim: true, maxlength: 30, default: '' },
  active: { type: Boolean, default: true },
});

const branchSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  code: { type: String, trim: true, uppercase: true, maxlength: 12 },
  businessLine: {
    type: String,
    enum: ['filling_station', 'building_materials', 'general'],
    default: 'general',
  },
  address: { type: String, trim: true, maxlength: 300 },
  city: { type: String, trim: true, maxlength: 80 },
  state: { type: String, trim: true, maxlength: 80 },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  staff: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  departments: { type: [departmentSchema], default: [] },
  dailySalesTarget: { type: Number, default: 0, min: 0 },
  // Current pump prices (₦/litre) — prefilled into new fuel reports.
  fuelPrices: {
    PMS: { type: Number, default: 0 },
    AGO: { type: Number, default: 0 },
    DPK: { type: Number, default: 0 },
  },
  // Forecourt layout — filling stations only.
  nozzles: { type: [nozzleSchema], default: [] },
  dutyStaff: { type: [dutyStaffSchema], default: [] },
  shifts: { type: [shiftSchema], default: () => DEFAULT_SHIFTS.map((x) => ({ ...x })) },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

branchSchema.index({ companyId: 1, name: 1 });

const DEFAULT_BRANCH_DEPARTMENTS = {
  filling_station: ['Forecourt (Pumps)', 'Lubricants & Shop', 'Gas (LPG)'],
  building_materials: ['Cement & Blocks', 'Iron Rods & Steel', 'Roofing & Finishing', 'Plumbing & Electrical'],
  general: ['Sales'],
};

module.exports = mongoose.model('Branch', branchSchema);
module.exports.DEFAULT_BRANCH_DEPARTMENTS = DEFAULT_BRANCH_DEPARTMENTS;
module.exports.DEFAULT_SHIFTS = DEFAULT_SHIFTS;
