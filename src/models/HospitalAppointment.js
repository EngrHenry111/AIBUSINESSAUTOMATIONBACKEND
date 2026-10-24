'use strict';

const mongoose = require('mongoose');

// A booked slot with a doctor or clinic. Checking the patient in turns it
// into a visit (status checked_in, visitId set).
const hospitalAppointmentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  department: { type: String, trim: true, maxlength: 120 },
  date: { type: String, required: true }, // YYYY-MM-DD
  time: { type: String, trim: true, maxlength: 5 }, // HH:mm
  reason: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ['booked', 'checked_in', 'cancelled', 'no_show'], default: 'booked' },
  visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalVisit' },
  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

hospitalAppointmentSchema.index({ companyId: 1, date: 1, time: 1 });
hospitalAppointmentSchema.index({ companyId: 1, patientId: 1, date: -1 });
hospitalAppointmentSchema.index({ companyId: 1, doctorId: 1, date: 1 });

module.exports = mongoose.model('HospitalAppointment', hospitalAppointmentSchema);
