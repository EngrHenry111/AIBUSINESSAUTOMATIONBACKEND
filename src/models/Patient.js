'use strict';

const mongoose = require('mongoose');

const nextOfKinSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 200 },
  relationship: { type: String, trim: true, maxlength: 60 },
  phone: { type: String, trim: true, maxlength: 40 },
  address: { type: String, trim: true, maxlength: 400 },
}, { _id: false });

const insuranceSchema = new mongoose.Schema({
  hmo: { type: String, trim: true, maxlength: 120 }, // matches a name in HospitalSettings.hmos
  enrolleeId: { type: String, trim: true, maxlength: 60 },
  plan: { type: String, trim: true, maxlength: 60 },
  expiresAt: Date,
}, { _id: false });

const patientSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  hospitalNumber: { type: String, required: true, trim: true },
  firstName: { type: String, required: true, trim: true, maxlength: 100 },
  lastName: { type: String, required: true, trim: true, maxlength: 100 },
  otherNames: { type: String, trim: true, maxlength: 100 },
  gender: { type: String, enum: ['male', 'female'] },
  dateOfBirth: Date,
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  address: { type: String, trim: true, maxlength: 400 },
  occupation: { type: String, trim: true, maxlength: 100 },
  maritalStatus: { type: String, trim: true, maxlength: 30 },
  stateOfOrigin: { type: String, trim: true, maxlength: 100 },
  religion: { type: String, trim: true, maxlength: 60 },

  bloodGroup: { type: String, trim: true, maxlength: 10 },
  genotype: { type: String, trim: true, maxlength: 10 },
  allergies: [{ type: String, trim: true, maxlength: 120 }],
  chronicConditions: [{ type: String, trim: true, maxlength: 120 }],
  medicalNotes: { type: String, trim: true, maxlength: 2000 },

  nextOfKin: nextOfKinSchema,
  insurance: insuranceSchema,
  photo: { type: String, trim: true },
  status: { type: String, enum: ['active', 'inactive', 'deceased'], default: 'active' },
  registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastVisitAt: Date,
}, { timestamps: true });

patientSchema.virtual('fullName').get(function fullName() {
  return [this.lastName, this.firstName, this.otherNames].filter(Boolean).join(' ');
});
patientSchema.set('toJSON', { virtuals: true });
patientSchema.set('toObject', { virtuals: true });

patientSchema.index({ companyId: 1, hospitalNumber: 1 }, { unique: true });
patientSchema.index({ companyId: 1, lastName: 1, firstName: 1 });
patientSchema.index({ companyId: 1, phone: 1 });
patientSchema.index({ companyId: 1, 'insurance.hmo': 1 });

module.exports = mongoose.model('Patient', patientSchema);
