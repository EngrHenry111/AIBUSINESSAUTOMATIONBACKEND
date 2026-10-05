'use strict';

const mongoose = require('mongoose');

// An application for a place — submitted online by a parent or entered by
// staff for a walk-in. It moves through review/interview to a decision, and
// an admitted application is enrolled into a Student record exactly once.
const STATUSES = ['submitted', 'under_review', 'interview', 'admitted', 'rejected', 'enrolled', 'withdrawn'];

const admissionApplicationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  applicationNumber: { type: String, required: true },
  status: { type: String, enum: STATUSES, default: 'submitted' },
  source: { type: String, enum: ['online', 'walk_in'], default: 'walk_in' },

  firstName: { type: String, required: true, trim: true, maxlength: 100 },
  lastName: { type: String, required: true, trim: true, maxlength: 100 },
  otherNames: { type: String, trim: true, maxlength: 100 },
  gender: { type: String, enum: ['male', 'female'] },
  dateOfBirth: Date,
  classAppliedFor: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' },
  previousSchool: { type: String, trim: true, maxlength: 200 },
  address: { type: String, trim: true, maxlength: 400 },
  medicalNotes: { type: String, trim: true, maxlength: 2000 },
  guardian: {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    relationship: { type: String, trim: true, maxlength: 60 },
    phone: { type: String, required: true, trim: true, maxlength: 40 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    address: { type: String, trim: true, maxlength: 400 },
    occupation: { type: String, trim: true, maxlength: 100 },
  },

  interviewDate: Date,
  entranceScore: { type: Number, min: 0, max: 100 },
  notes: { type: String, trim: true, maxlength: 4000 },
  decidedAt: Date,
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
}, { timestamps: true });

admissionApplicationSchema.index({ companyId: 1, applicationNumber: 1 }, { unique: true });
admissionApplicationSchema.index({ companyId: 1, status: 1, createdAt: -1 });

admissionApplicationSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('AdmissionApplication', admissionApplicationSchema);
