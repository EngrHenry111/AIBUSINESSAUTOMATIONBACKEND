'use strict';

const mongoose = require('mongoose');

// One trip to the hospital (an encounter): check-in → triage → doctor →
// completed or admitted. Holds the day's queue number, the vitals taken and
// the doctor's consultation notes. Its charges collect on one HospitalBill.
const STATUSES = ['waiting', 'triaged', 'in_consultation', 'completed', 'admitted', 'cancelled'];

const vitalsSchema = new mongoose.Schema({
  systolic: Number, diastolic: Number, // mmHg
  temperature: Number, // °C
  pulse: Number, // bpm
  respiration: Number, // breaths/min
  spo2: Number, // %
  weight: Number, // kg
  height: Number, // cm
  bmi: Number,
  glucose: Number, // mmol/L
  painScore: Number, // 0-10
  note: { type: String, trim: true, maxlength: 500 },
  takenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  takenAt: { type: Date, default: Date.now },
});

const hospitalVisitSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  visitNumber: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD in the hospital's timezone
  queueNumber: Number,
  type: { type: String, enum: ['outpatient', 'emergency', 'follow_up', 'antenatal', 'inpatient'], default: 'outpatient' },
  priority: { type: String, enum: ['normal', 'urgent', 'emergency'], default: 'normal' },
  department: { type: String, trim: true, maxlength: 120 },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: STATUSES, default: 'waiting' },
  reason: { type: String, trim: true, maxlength: 500 }, // why the patient came, from the desk

  vitals: [vitalsSchema],
  consultation: {
    complaint: { type: String, trim: true, maxlength: 2000 },
    history: { type: String, trim: true, maxlength: 5000 },
    examination: { type: String, trim: true, maxlength: 5000 },
    assessment: { type: String, trim: true, maxlength: 3000 },
    diagnoses: [{ code: { type: String, trim: true, maxlength: 20 }, text: { type: String, trim: true, maxlength: 200 }, _id: false }],
    plan: { type: String, trim: true, maxlength: 5000 },
    followUpDate: Date,
    startedAt: Date,
    completedAt: Date,
  },

  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalBill' },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'HospitalAppointment' },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admission' },
  checkedInBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  timeline: [{ status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, _id: false }],
}, { timestamps: true });

hospitalVisitSchema.index({ companyId: 1, visitNumber: 1 }, { unique: true });
hospitalVisitSchema.index({ companyId: 1, date: 1, status: 1 });
hospitalVisitSchema.index({ companyId: 1, patientId: 1, createdAt: -1 });
hospitalVisitSchema.index({ companyId: 1, doctorId: 1, date: 1 });
hospitalVisitSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('HospitalVisit', hospitalVisitSchema);
