'use strict';

const mongoose = require('mongoose');

// Comments printed on a student's report card for one term.
const reportCardRemarkSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  session: { type: String, required: true },
  term: { type: String, enum: ['first', 'second', 'third'], required: true },
  teacherComment: { type: String, trim: true, maxlength: 1000 },
  principalComment: { type: String, trim: true, maxlength: 1000 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

reportCardRemarkSchema.index({ companyId: 1, studentId: 1, session: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('ReportCardRemark', reportCardRemarkSchema);
