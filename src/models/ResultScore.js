'use strict';

const mongoose = require('mongoose');

// One student's score in one subject for one term. Report cards (totals,
// average, class position) are computed from these on read.
const resultScoreSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
  session: { type: String, required: true },
  term: { type: String, enum: ['first', 'second', 'third'], required: true },
  subject: { type: String, required: true, trim: true, maxlength: 100 },
  ca: { type: Number, min: 0, max: 100, default: 0 },
  exam: { type: Number, min: 0, max: 100, default: 0 },
  total: { type: Number, min: 0, max: 100, default: 0 },
  grade: String,
  remark: String,
  enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

resultScoreSchema.index({ companyId: 1, studentId: 1, session: 1, term: 1, subject: 1 }, { unique: true });
resultScoreSchema.index({ companyId: 1, classId: 1, session: 1, term: 1, subject: 1 });

module.exports = mongoose.model('ResultScore', resultScoreSchema);
