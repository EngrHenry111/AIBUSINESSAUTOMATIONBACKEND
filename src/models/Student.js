'use strict';

const mongoose = require('mongoose');

const guardianSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 200 },
  relationship: { type: String, trim: true, maxlength: 60 },
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  address: { type: String, trim: true, maxlength: 400 },
  occupation: { type: String, trim: true, maxlength: 100 },
}, { _id: false });

const studentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  admissionNumber: { type: String, required: true, trim: true },
  firstName: { type: String, required: true, trim: true, maxlength: 100 },
  lastName: { type: String, required: true, trim: true, maxlength: 100 },
  otherNames: { type: String, trim: true, maxlength: 100 },
  gender: { type: String, enum: ['male', 'female'] },
  dateOfBirth: Date,
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' },
  status: { type: String, enum: ['active', 'suspended', 'withdrawn', 'graduated'], default: 'active' },
  guardian: guardianSchema,
  address: { type: String, trim: true, maxlength: 400 },
  stateOfOrigin: { type: String, trim: true, maxlength: 100 },
  religion: { type: String, trim: true, maxlength: 60 },
  bloodGroup: { type: String, trim: true, maxlength: 10 },
  medicalNotes: { type: String, trim: true, maxlength: 2000 },
  previousSchool: { type: String, trim: true, maxlength: 200 },
  photo: { type: String, trim: true },
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionApplication' },
  admittedAt: { type: Date, default: Date.now },
  leftAt: Date,
}, { timestamps: true });

studentSchema.virtual('fullName').get(function fullName() {
  return [this.lastName, this.firstName, this.otherNames].filter(Boolean).join(' ');
});
studentSchema.set('toJSON', { virtuals: true });
studentSchema.set('toObject', { virtuals: true });

studentSchema.index({ companyId: 1, admissionNumber: 1 }, { unique: true });
studentSchema.index({ companyId: 1, classId: 1, status: 1, lastName: 1 });
studentSchema.index({ companyId: 1, 'guardian.email': 1 });
studentSchema.index({ companyId: 1, 'guardian.phone': 1 });

module.exports = mongoose.model('Student', studentSchema);
