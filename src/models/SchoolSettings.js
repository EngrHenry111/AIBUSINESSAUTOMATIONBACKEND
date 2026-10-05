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
