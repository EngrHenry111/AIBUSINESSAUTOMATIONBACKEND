'use strict';

const mongoose = require('mongoose');

// One class register for one day.
const attendanceRecordSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // school-local day
  session: String,
  term: String,
  records: [{
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    status: { type: String, enum: ['present', 'absent', 'late', 'excused'], default: 'present' },
    note: { type: String, trim: true, maxlength: 200 },
    _id: false,
  }],
  takenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

attendanceRecordSchema.index({ companyId: 1, classId: 1, date: 1 }, { unique: true });
attendanceRecordSchema.index({ companyId: 1, date: 1 });
attendanceRecordSchema.index({ companyId: 1, 'records.studentId': 1, date: -1 });

module.exports = mongoose.model('AttendanceRecord', attendanceRecordSchema);
