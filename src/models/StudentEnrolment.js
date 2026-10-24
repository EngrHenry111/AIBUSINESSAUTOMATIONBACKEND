'use strict';

const mongoose = require('mongoose');

// A student's place in one session: the class level they were in and the
// register number issued for it. Numbers are counted per level per session
// (all JSS 1 arms share 001…N), never across the whole school, so a level of
// 32 students runs 001–032. The ledger keeps past sessions' numbers intact
// for old report cards after promotion. See utils/schoolRegNumbers.js.
const studentEnrolmentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  session: { type: String, required: true, trim: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' },
  levelCode: { type: String, required: true, trim: true },
  serial: { type: Number, required: true, min: 1 },
  regNumber: { type: String, required: true, trim: true },
}, { timestamps: true });

studentEnrolmentSchema.index({ companyId: 1, session: 1, studentId: 1 }, { unique: true });
studentEnrolmentSchema.index({ companyId: 1, session: 1, levelCode: 1, serial: 1 }, { unique: true });
studentEnrolmentSchema.index({ companyId: 1, session: 1, regNumber: 1 }, { unique: true });
studentEnrolmentSchema.index({ companyId: 1, studentId: 1, session: -1 });

module.exports = mongoose.model('StudentEnrolment', studentEnrolmentSchema);
