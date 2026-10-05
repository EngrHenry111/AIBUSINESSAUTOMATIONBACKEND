'use strict';

const mongoose = require('mongoose');

// A class's weekly timetable for a term. `period` indexes the school's bell
// times (SchoolSettings.periods); day 1 = Monday … 5 = Friday.
const timetableSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
  session: { type: String, required: true },
  term: { type: String, enum: ['first', 'second', 'third'], required: true },
  slots: [{
    day: { type: Number, min: 1, max: 5, required: true },
    period: { type: Number, min: 0, max: 20, required: true },
    subject: { type: String, trim: true, maxlength: 100, required: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    _id: false,
  }],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

timetableSchema.index({ companyId: 1, classId: 1, session: 1, term: 1 }, { unique: true });
timetableSchema.index({ companyId: 1, session: 1, term: 1, 'slots.teacher': 1 });

module.exports = mongoose.model('Timetable', timetableSchema);
