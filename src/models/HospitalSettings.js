'use strict';

const mongoose = require('mongoose');

// One per hospital (company): its details, the price list every charge is
// taken from, the HMOs it accepts, and the payment rules for the lab and
// pharmacy. Created lazily by utils/hospital.getSettings.

const DEFAULT_DEPARTMENTS = [
  'General Outpatient (GOPD)', 'Emergency', 'Internal Medicine', 'Paediatrics', 'Obstetrics & Gynaecology',
  'Antenatal', 'Surgery', 'Dental', 'Eye Clinic',
];

const DEFAULT_SERVICES = [
  { name: 'Registration / hospital card', category: 'registration', price: 2000 },
  { name: 'GOPD consultation', category: 'consultation', price: 5000 },
  { name: 'Specialist consultation', category: 'consultation', price: 10000 },
  { name: 'Emergency consultation', category: 'consultation', price: 10000 },
  { name: 'Follow-up consultation', category: 'consultation', price: 3000 },
  { name: 'Antenatal booking', category: 'consultation', price: 15000 },
  { name: 'Injection administration', category: 'nursing', price: 500 },
  { name: 'Wound dressing', category: 'nursing', price: 2000 },
  { name: 'IV cannulation & drip setup', category: 'nursing', price: 2500 },
  { name: 'Suturing (minor)', category: 'procedure', price: 7500 },
  { name: 'Incision & drainage', category: 'procedure', price: 15000 },
  { name: 'Normal delivery', category: 'procedure', price: 80000 },
];

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, enum: ['registration', 'consultation', 'nursing', 'procedure', 'other'], default: 'other' },
  price: { type: Number, min: 0, default: 0 },
  active: { type: Boolean, default: true },
});

const hmoSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  coverPercent: { type: Number, min: 0, max: 100, default: 100 }, // share of each bill the HMO pays
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  active: { type: Boolean, default: true },
});

const hospitalSettingsSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  hospitalName: { type: String, trim: true, maxlength: 200 },
  address: { type: String, trim: true, maxlength: 400 },
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  logo: { type: String, trim: true },

  patientNumberPrefix: { type: String, trim: true, uppercase: true, maxlength: 12, default: 'PT' },
  chargeRegistration: { type: Boolean, default: true }, // bill the registration service on a new patient

  departments: { type: [String], default: () => [...DEFAULT_DEPARTMENTS] },
  services: { type: [serviceSchema], default: () => DEFAULT_SERVICES.map((s) => ({ ...s })) },
  hmos: { type: [hmoSchema], default: [] },

  // Many Nigerian hospitals collect money before the lab takes a sample or
  // the pharmacy hands over drugs.
  payBeforeLab: { type: Boolean, default: false },
  payBeforePharmacy: { type: Boolean, default: false },
  pricesConfirmed: { type: Boolean, default: false }, // price list saved at least once (setup checklist)
}, { timestamps: true });

hospitalSettingsSchema.statics.DEFAULT_DEPARTMENTS = DEFAULT_DEPARTMENTS;

module.exports = mongoose.model('HospitalSettings', hospitalSettingsSchema);
