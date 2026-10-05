'use strict';

const mongoose = require('mongoose');

// One paper in the exam timetable: a class sitting a subject at a time.
const examPaperSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  session: { type: String, required: true },
  term: { type: String, enum: ['first', 'second', 'third'], required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
  subject: { type: String, required: true, trim: true, maxlength: 100 },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  start: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  end: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  venue: { type: String, trim: true, maxlength: 100 },
  invigilator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes: { type: String, trim: true, maxlength: 300 },
}, { timestamps: true });

examPaperSchema.index({ companyId: 1, session: 1, term: 1, date: 1, start: 1 });
examPaperSchema.index({ companyId: 1, classId: 1, session: 1, term: 1 });

module.exports = mongoose.model('ExamPaper', examPaperSchema);
