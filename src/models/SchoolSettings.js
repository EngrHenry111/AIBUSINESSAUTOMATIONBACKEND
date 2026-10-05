'use strict';

const mongoose = require('mongoose');

// One per school (company). Holds the academic calendar the rest of the
// school module keys off — the current session/term decide which fee bills,
// attendance and results a screen shows by default — plus the public slug
// for the online admission form and the parent fee-payment page.

const DEFAULT_GRADES = [
  { grade: 'A', min: 70, remark: 'Excellent' },
  { grade: 'B', min: 60, remark: 'Very good' },
  { grade: 'C', min: 50, remark: 'Good' },
  { grade: 'D', min: 45, remark: 'Fair' },
  { grade: 'E', min: 40, remark: 'Pass' },
  { grade: 'F', min: 0, remark: 'Fail' },
];

function defaultSession() {
  const now = new Date();
  const y = now.getFullYear();
  // Nigerian sessions start in September.
  return now.getMonth() >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

const schoolSettingsSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  schoolName: { type: String, trim: true, maxlength: 200 },
  motto: { type: String, trim: true, maxlength: 200 },
  address: { type: String, trim: true, maxlength: 400 },
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  logo: { type: String, trim: true },

  // Public pages: /schools/:slug/apply and /schools/:slug/pay
  slug: { type: String, required: true, lowercase: true, trim: true, unique: true },

  currentSession: { type: String, trim: true, default: defaultSession },
  currentTerm: { type: String, enum: ['first', 'second', 'third'], default: 'first' },
  termStart: Date,
  termEnd: Date,

  admissionsOpen: { type: Boolean, default: true },
  admissionNumberPrefix: { type: String, trim: true, uppercase: true, maxlength: 12, default: 'STU' },
  onlinePaymentsEnabled: { type: Boolean, default: true },
  minimumOnlinePayment: { type: Number, min: 0, default: 1000 },

  // Score split — CA max + exam max always add up to 100.
  caMax: { type: Number, min: 0, max: 100, default: 40 },
  gradingScale: {
    type: [{ grade: String, min: Number, remark: String, _id: false }],
    default: () => DEFAULT_GRADES.map((g) => ({ ...g })),
  },

  nextTermBegins: Date, // printed on report cards

  periodsConfirmed: { type: Boolean, default: false }, // saved at least once (setup checklist)
  // Bell times — the rows of every class timetable.
  periods: {
    type: [{ label: String, start: String, end: String, isBreak: Boolean, _id: false }],
    default: () => [
      { label: '1', start: '08:00', end: '08:40' }, { label: '2', start: '08:40', end: '09:20' },
      { label: '3', start: '09:20', end: '10:00' }, { label: 'Break', start: '10:00', end: '10:30', isBreak: true },
      { label: '4', start: '10:30', end: '11:10' }, { label: '5', start: '11:10', end: '11:50' },
      { label: '6', start: '11:50', end: '12:30' }, { label: 'Lunch', start: '12:30', end: '13:00', isBreak: true },
      { label: '7', start: '13:00', end: '13:40' }, { label: '8', start: '13:40', end: '14:20' },
    ],
  },

  // Dedicated bank account per student — transfers are matched automatically.
  bankAccounts: {
    enabled: { type: Boolean, default: false },
    autoCreate: { type: Boolean, default: true }, // new students get one on enrolment
    preferredBank: { type: String, default: 'wema-bank' }, // Paystack slug: wema-bank, titan-paystack (test-bank in test mode)
  },

  // Fee reminders to parents of students who owe (utils/schoolFeeReminders.js).
  reminders: {
    autoEnabled: { type: Boolean, default: false },
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: true },
    whatsapp: { type: Boolean, default: false },
    daysBeforeDue: { type: Number, min: 0, max: 60, default: 3 },
    repeatEveryDays: { type: Number, min: 1, max: 60, default: 7 },
  },

  // Results parents can see on the portal — per class and term. Scores
  // stay staff-only until the school publishes them.
  publishedResults: [{
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' },
    session: String,
    term: String,
    publishedAt: Date,
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    _id: false,
  }],

  // Atomic number sequences — $inc'd so two simultaneous admissions or
  // payments can never be issued the same number.
  counters: {
    application: { type: Number, default: 0 },
    admission: { type: Number, default: 0 },
    bill: { type: Number, default: 0 },
    receipt: { type: Number, default: 0 },
  },
}, { timestamps: true });

schoolSettingsSchema.statics.DEFAULT_GRADES = DEFAULT_GRADES;

module.exports = mongoose.model('SchoolSettings', schoolSettingsSchema);
