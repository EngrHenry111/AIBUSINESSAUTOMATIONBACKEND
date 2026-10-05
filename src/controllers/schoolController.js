'use strict';

const mongoose = require('mongoose');
const SchoolSettings = require('../models/SchoolSettings');
const SchoolClass = require('../models/SchoolClass');
const Student = require('../models/Student');
const AdmissionApplication = require('../models/AdmissionApplication');
const FeeBill = require('../models/FeeBill');
const FeePayment = require('../models/FeePayment');
const AttendanceRecord = require('../models/AttendanceRecord');
const User = require('../models/User');
const emailService = require('../services/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const SchoolStaff = require('../models/SchoolStaff');
const { isTeacher, assertClassAccess, classFilterFor } = require('../utils/schoolAccess');
const logger = require('../utils/logger');
const {
  TERMS, oid, escapeRe, slugify, getSettings, nextNumber, reserveNumbers, formatNumber,
  emitSchool, todayStr, billNewStudent,
} = require('../utils/school');

const SETTINGS_FIELDS = [
  'schoolName', 'motto', 'address', 'phone', 'email', 'logo', 'currentSession', 'currentTerm',
  'termStart', 'termEnd', 'admissionsOpen', 'admissionNumberPrefix', 'onlinePaymentsEnabled',
  'minimumOnlinePayment', 'caMax', 'gradingScale', 'nextTermBegins', 'reminders',
];
const CLASS_FIELDS = ['name', 'level', 'section', 'classTeacher', 'subjects', 'subjectTeachers', 'capacity', 'active'];
const STUDENT_FIELDS = [
  'firstName', 'lastName', 'otherNames', 'gender', 'dateOfBirth', 'classId', 'status', 'guardian',
  'address', 'stateOfOrigin', 'religion', 'bloodGroup', 'medicalNotes', 'previousSchool', 'photo', 'admittedAt',
];
const APPLICATION_FIELDS = [
  'firstName', 'lastName', 'otherNames', 'gender', 'dateOfBirth', 'classAppliedFor', 'previousSchool',
  'address', 'medicalNotes', 'guardian', 'interviewDate', 'entranceScore', 'notes',
];
const GUARDIAN_FIELDS = ['name', 'relationship', 'phone', 'email', 'address', 'occupation'];

const io = (req) => req.app.get('io');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function findOwned(Model, req, id = req.params.id, label = 'Record') {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${label} not found.`, 404);
  const doc = await Model.findOne({ _id: id, companyId: req.companyId });
  if (!doc) throw new AppError(`${label} not found.`, 404);
  return doc;
}

// A classId from the client must be one of this school's classes.
async function assertClass(companyId, classId) {
  if (classId == null || classId === '') return null;
  if (!mongoose.isValidObjectId(classId) || !(await SchoolClass.exists({ _id: classId, companyId }))) {
    throw new AppError('Class not found.', 400);
  }
  return classId;
}

function cleanGuardian(g) {
  return g && typeof g === 'object' ? pick(g, GUARDIAN_FIELDS) : undefined;
}

function sendGuardianEmail(to, subject, html) {
  if (!to) return;
  emailService.sendEmail({ to, subject, html }).catch((e) => logger.error(`School email to ${to} failed: ${e.message}`));
}

function emailShell(settings, body) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">
    <h2 style="margin:0 0 4px">${escapeHtml(settings.schoolName || 'School')}</h2>
    ${settings.motto ? `<div style="color:#64748b;font-size:13px;margin-bottom:16px">${escapeHtml(settings.motto)}</div>` : ''}
    ${body}
    <p style="color:#64748b;font-size:12px;margin-top:24px">${escapeHtml([settings.address, settings.phone, settings.email].filter(Boolean).join(' · '))}</p>
  </div>`;
}

// ── Settings ─────────────────────────────────────────────────────────────
exports.getSettings = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getSettings(req.companyId) });
  } catch (err) { next(err); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const body = pick(req.body, SETTINGS_FIELDS);
    if (body.currentTerm && !TERMS.includes(body.currentTerm)) return next(new AppError('Invalid term.', 400));
    if (body.currentSession && !/^\d{4}\/\d{4}$/.test(body.currentSession)) return next(new AppError('Session must look like 2026/2027.', 400));
    if (Array.isArray(body.gradingScale)) {
      body.gradingScale = body.gradingScale
        .filter((g) => g && String(g.grade || '').trim())
        .map((g) => ({ grade: String(g.grade).trim().slice(0, 5), min: Math.min(100, Math.max(0, Number(g.min) || 0)), remark: String(g.remark || '').slice(0, 60) }));
      if (!body.gradingScale.some((g) => g.min === 0)) return next(new AppError('The grading scale needs a grade starting at 0.', 400));
    }
    if (body.reminders !== undefined) {
      const r = body.reminders || {};
      const days = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.round(Number(v)) : d));
      body.reminders = {
        autoEnabled: Boolean(r.autoEnabled), email: r.email !== false, sms: r.sms !== false, whatsapp: Boolean(r.whatsapp),
        daysBeforeDue: days(r.daysBeforeDue, 0, 60, 3), repeatEveryDays: days(r.repeatEveryDays, 1, 60, 7),
      };
    }
    if (body.nextTermBegins === '') body.nextTermBegins = null;
    if (req.body.slug !== undefined) {
      const slug = slugify(req.body.slug);
      if (slug !== settings.slug && await SchoolSettings.exists({ slug, _id: { $ne: settings._id } })) {
        return next(new AppError('That link name is already taken.', 400));
      }
      body.slug = slug;
    }
    Object.assign(settings, body);
    await settings.save();
    emitSchool(io(req), req.companyId, 'settings');
    res.status(200).json({ success: true, data: settings });
  } catch (err) { next(err); }
};

// ── Dashboard ────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const cid = oid(req.companyId);
    const { currentSession: session, currentTerm: term } = settings;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const since30 = new Date(startOfDay.getTime() - 29 * 24 * 60 * 60 * 1000);

    const [byClass, byGender, admissions, recentApplications, feeTotals, feeByStatus, todayPaid, daily, recentPayments, attendanceToday, classes] = await Promise.all([
      Student.aggregate([{ $match: { companyId: cid, status: 'active' } }, { $group: { _id: '$classId', count: { $sum: 1 } } }]),
      Student.aggregate([{ $match: { companyId: cid, status: 'active' } }, { $group: { _id: '$gender', count: { $sum: 1 } } }]),
      AdmissionApplication.aggregate([{ $match: { companyId: cid } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      AdmissionApplication.find({ companyId: req.companyId, status: { $in: ['submitted', 'under_review', 'interview'] } })
        .sort({ createdAt: -1 }).limit(5).select('applicationNumber firstName lastName status createdAt classAppliedFor source').populate('classAppliedFor', 'name').lean(),
      FeeBill.aggregate([
        { $match: { companyId: cid, session, term, status: { $nin: ['waived', 'cancelled'] } } },
        { $group: { _id: null, expected: { $sum: '$total' }, collected: { $sum: '$amountPaid' }, outstanding: { $sum: { $max: ['$balance', 0] } }, bills: { $sum: 1 } } },
      ]),
      FeeBill.aggregate([{ $match: { companyId: cid, session, term } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      FeePayment.aggregate([
        { $match: { companyId: cid, voided: false, paidAt: { $gte: startOfDay } } },
        { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      FeePayment.aggregate([
        { $match: { companyId: cid, voided: false, paidAt: { $gte: since30 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: process.env.SCHOOL_TZ || 'Africa/Lagos' } }, amount: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]),
      FeePayment.find({ companyId: req.companyId, voided: false }).sort({ paidAt: -1 }).limit(8)
        .populate('studentId', 'firstName lastName admissionNumber').lean(),
      AttendanceRecord.aggregate([
        { $match: { companyId: cid, date: todayStr() } },
        { $unwind: '$records' },
        { $group: { _id: '$records.status', count: { $sum: 1 } } },
      ]),
      SchoolClass.find({ companyId: req.companyId, active: true }).sort({ level: 1, name: 1 }).select('name level capacity').lean(),
    ]);

    const countByClass = new Map(byClass.map((c) => [String(c._id), c.count]));
    const att = Object.fromEntries(attendanceToday.map((a) => [a._id, a.count]));
    const attTotal = Object.values(att).reduce((s, n) => s + n, 0);
    const days = [];
    const dailyMap = new Map(daily.map((d) => [d._id, d.amount]));
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(startOfDay.getTime() - i * 24 * 60 * 60 * 1000);
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.SCHOOL_TZ || 'Africa/Lagos' }).format(d);
      days.push({ date: key, amount: dailyMap.get(key) || 0 });
    }

    res.status(200).json({
      success: true,
      data: {
        settings: { currentSession: session, currentTerm: term, schoolName: settings.schoolName, slug: settings.slug },
        students: {
          total: byClass.reduce((s, c) => s + c.count, 0),
          byGender: Object.fromEntries(byGender.map((g) => [g._id || 'unspecified', g.count])),
          byClass: classes.map((c) => ({ _id: c._id, name: c.name, capacity: c.capacity, count: countByClass.get(String(c._id)) || 0 })),
          unassigned: countByClass.get('null') || 0,
        },
        admissions: { byStatus: Object.fromEntries(admissions.map((a) => [a._id, a.count])), recent: recentApplications },
        fees: {
          ...(feeTotals[0] || { expected: 0, collected: 0, outstanding: 0, bills: 0 }),
          byStatus: Object.fromEntries(feeByStatus.map((f) => [f._id, f.count])),
          today: todayPaid[0] || { amount: 0, count: 0 },
          daily: days,
          recentPayments,
        },
        attendance: { date: todayStr(), total: attTotal, present: (att.present || 0) + (att.late || 0), absent: att.absent || 0, late: att.late || 0, excused: att.excused || 0 },
      },
    });
  } catch (err) { next(err); }
};

// ── Classes ──────────────────────────────────────────────────────────────
async function cleanClassBody(req) {
  const body = pick(req.body, CLASS_FIELDS);
  if (body.subjects !== undefined) {
    body.subjects = [...new Set((Array.isArray(body.subjects) ? body.subjects : String(body.subjects).split(','))
      .map((s) => String(s).trim()).filter(Boolean))].slice(0, 40);
  }
  if (body.classTeacher !== undefined) {
    body.classTeacher = body.classTeacher && mongoose.isValidObjectId(body.classTeacher)
      && await User.exists({ _id: body.classTeacher, companyId: req.companyId }) ? body.classTeacher : null;
  }
  if (body.subjectTeachers !== undefined) {
    const rows = (Array.isArray(body.subjectTeachers) ? body.subjectTeachers : [])
      .filter((r) => r && String(r.subject || '').trim() && mongoose.isValidObjectId(r.teacher));
    const valid = new Set((await User.find({ _id: { $in: rows.map((r) => r.teacher) }, companyId: req.companyId }).select('_id').lean()).map((u) => String(u._id)));
    const seen = new Set();
    body.subjectTeachers = rows
      .map((r) => ({ subject: String(r.subject).trim().slice(0, 100), teacher: r.teacher }))
      .filter((r) => valid.has(String(r.teacher)) && !seen.has(r.subject) && seen.add(r.subject));
  }
  return body;
}

exports.getClasses = async (req, res, next) => {
  try {
    const [classes, counts] = await Promise.all([
      SchoolClass.find({ companyId: req.companyId, ...(isTeacher(req) && { _id: classFilterFor(req) }) })
        .sort({ level: 1, name: 1 }).populate('classTeacher', 'name email').populate('subjectTeachers.teacher', 'name').lean(),
      Student.aggregate([{ $match: { companyId: oid(req.companyId), status: 'active' } }, { $group: { _id: '$classId', count: { $sum: 1 } } }]),
    ]);
    const map = new Map(counts.map((c) => [String(c._id), c.count]));
    res.status(200).json({ success: true, data: classes.map((c) => ({ ...c, studentCount: map.get(String(c._id)) || 0 })) });
  } catch (err) { next(err); }
};

exports.createClass = async (req, res, next) => {
  try {
    const body = await cleanClassBody(req);
    if (!body.name) return next(new AppError('Class name is required.', 400));
    const cls = await SchoolClass.create({ ...body, companyId: req.companyId });
    emitSchool(io(req), req.companyId, 'classes');
    res.status(201).json({ success: true, data: cls });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A class with that name already exists.', 400));
    next(err);
  }
};

exports.updateClass = async (req, res, next) => {
  try {
    const cls = await findOwned(SchoolClass, req, req.params.id, 'Class');
    Object.assign(cls, await cleanClassBody(req));
    await cls.save();
    emitSchool(io(req), req.companyId, 'classes');
    res.status(200).json({ success: true, data: cls });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A class with that name already exists.', 400));
    next(err);
  }
};

exports.deleteClass = async (req, res, next) => {
  try {
    const cls = await findOwned(SchoolClass, req, req.params.id, 'Class');
    if (await Student.exists({ companyId: req.companyId, classId: cls._id, status: 'active' })) {
      return next(new AppError('Move this class\'s students to another class first.', 400));
    }
    await cls.deleteOne();
    emitSchool(io(req), req.companyId, 'classes');
    res.status(200).json({ success: true, message: 'Class deleted.' });
  } catch (err) { next(err); }
};

// ── Students ─────────────────────────────────────────────────────────────
exports.getStudents = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { companyId: req.companyId };
    if (req.query.status) filter.status = req.query.status;
    else filter.status = 'active';
    if (req.query.status === 'all') delete filter.status;
    if (req.query.classId === 'none' && !isTeacher(req)) filter.classId = null;
    else {
      const cf = classFilterFor(req, mongoose.isValidObjectId(req.query.classId) ? req.query.classId : undefined);
      if (cf) filter.classId = cf;
    }
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { otherNames: re }, { admissionNumber: re }, { 'guardian.name': re }, { 'guardian.phone': re }];
    }
    const [students, total] = await Promise.all([
      Student.find(filter).sort({ lastName: 1, firstName: 1 }).skip((page - 1) * limit).limit(limit).populate('classId', 'name').lean(),
      Student.countDocuments(filter),
    ]);
    // Outstanding balance per student, for the list's "owing" column.
    const owing = await FeeBill.aggregate([
      { $match: { companyId: oid(req.companyId), studentId: { $in: students.map((s) => s._id) }, status: { $in: ['unpaid', 'partial'] } } },
      { $group: { _id: '$studentId', balance: { $sum: '$balance' } } },
    ]);
    const owingMap = new Map(owing.map((o) => [String(o._id), o.balance]));
    res.status(200).json({
      success: true,
      data: students.map((s) => ({ ...s, fullName: [s.lastName, s.firstName, s.otherNames].filter(Boolean).join(' '), ...(!isTeacher(req) && { balance: owingMap.get(String(s._id)) || 0 }) })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

async function createStudentRecord(req, body, extra = {}) {
  const data = pick(body, STUDENT_FIELDS);
  data.guardian = cleanGuardian(data.guardian);
  data.classId = await assertClass(req.companyId, data.classId);
  if (!data.firstName || !data.lastName) throw new AppError('First and last name are required.', 400);
  let admissionNumber = String(body.admissionNumber || '').trim();
  if (!admissionNumber) admissionNumber = await nextNumber(req.companyId, 'admission');
  try {
    const student = await Student.create({ ...data, ...extra, admissionNumber, companyId: req.companyId });
    if (student.classId && student.status === 'active') await billNewStudent(student, req.user._id);
    return student;
  } catch (err) {
    if (err.code === 11000) throw new AppError(`Admission number ${admissionNumber} is already in use.`, 400);
    throw err;
  }
}

exports.createStudent = async (req, res, next) => {
  try {
    const student = await createStudentRecord(req, req.body);
    emitSchool(io(req), req.companyId, 'students', { studentId: student._id });
    res.status(201).json({ success: true, data: student });
  } catch (err) { next(err); }
};

// POST /school/students/bulk — import from a spreadsheet. Classes are
// matched by name; rows that fail are reported back, the rest are created.
exports.bulkCreateStudents = async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.students) ? req.body.students.slice(0, 1000) : [];
    if (!rows.length) return next(new AppError('No students to import.', 400));
    const classes = await SchoolClass.find({ companyId: req.companyId }).select('name').lean();
    const classByName = new Map(classes.map((c) => [c.name.trim().toLowerCase(), c._id]));

    const created = [];
    const failed = [];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i] || {};
      try {
        const className = String(r.className || r.class || '').trim().toLowerCase();
        const classId = className ? classByName.get(className) : undefined;
        if (className && !classId) throw new AppError(`Class "${r.className || r.class}" not found`, 400);
        const gender = String(r.gender || '').toLowerCase().startsWith('f') ? 'female' : (String(r.gender || '').toLowerCase().startsWith('m') ? 'male' : undefined);
        // eslint-disable-next-line no-await-in-loop
        const s = await createStudentRecord(req, {
          admissionNumber: r.admissionNumber,
          firstName: r.firstName, lastName: r.lastName, otherNames: r.otherNames,
          gender, dateOfBirth: r.dateOfBirth || undefined, classId,
          address: r.address,
          guardian: { name: r.guardianName, phone: r.guardianPhone, email: r.guardianEmail, relationship: r.guardianRelationship },
        });
        created.push(s._id);
      } catch (e) {
        failed.push({ row: i + 1, name: [r.lastName, r.firstName].filter(Boolean).join(' '), error: e.message });
      }
    }
    emitSchool(io(req), req.companyId, 'students');
    res.status(200).json({ success: true, data: { created: created.length, failed } });
  } catch (err) { next(err); }
};

exports.getStudent = async (req, res, next) => {
  try {
    const student = await findOwned(Student, req, req.params.id, 'Student');
    assertClassAccess(req, student.classId);
    await student.populate('classId', 'name subjects level');
    const settings = await getSettings(req.companyId);
    const teacher = isTeacher(req); // teachers don't see fees
    const [bills, payments, attendance, application] = await Promise.all([
      teacher ? [] : FeeBill.find({ companyId: req.companyId, studentId: student._id }).sort({ createdAt: -1 }).lean(),
      teacher ? [] : FeePayment.find({ companyId: req.companyId, studentId: student._id }).sort({ paidAt: -1 }).limit(100).populate('recordedBy', 'name').lean(),
      AttendanceRecord.aggregate([
        { $match: { companyId: oid(req.companyId), session: settings.currentSession, term: settings.currentTerm, 'records.studentId': student._id } },
        { $unwind: '$records' },
        { $match: { 'records.studentId': student._id } },
        { $group: { _id: '$records.status', count: { $sum: 1 } } },
      ]),
      student.applicationId ? AdmissionApplication.findById(student.applicationId).select('applicationNumber createdAt source').lean() : null,
    ]);
    const outstanding = bills.filter((b) => ['unpaid', 'partial'].includes(b.status)).reduce((s, b) => s + b.balance, 0);
    res.status(200).json({
      success: true,
      data: {
        student, bills, payments, application, outstanding, feesHidden: teacher,
        attendance: Object.fromEntries(attendance.map((a) => [a._id, a.count])),
        settings: { currentSession: settings.currentSession, currentTerm: settings.currentTerm },
      },
    });
  } catch (err) { next(err); }
};

exports.updateStudent = async (req, res, next) => {
  try {
    const student = await findOwned(Student, req, req.params.id, 'Student');
    const body = pick(req.body, STUDENT_FIELDS);
    if (body.guardian !== undefined) body.guardian = cleanGuardian(body.guardian);
    if (body.classId !== undefined) body.classId = await assertClass(req.companyId, body.classId);
    const classChanged = body.classId !== undefined && String(body.classId) !== String(student.classId);
    if (body.status && body.status !== 'active' && student.status === 'active') body.leftAt = new Date();
    if (body.status === 'active') body.leftAt = undefined;
    Object.assign(student, body);
    if (req.body.admissionNumber && req.body.admissionNumber !== student.admissionNumber) student.admissionNumber = String(req.body.admissionNumber).trim();
    await student.save();
    if (classChanged && student.classId && student.status === 'active') await billNewStudent(student, req.user._id);
    emitSchool(io(req), req.companyId, 'students', { studentId: student._id });
    res.status(200).json({ success: true, data: student });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('That admission number is already in use.', 400));
    next(err);
  }
};

exports.deleteStudent = async (req, res, next) => {
  try {
    const student = await findOwned(Student, req, req.params.id, 'Student');
    if (await FeePayment.exists({ companyId: req.companyId, studentId: student._id })) {
      return next(new AppError('This student has fee payments on record. Mark them as withdrawn instead of deleting.', 400));
    }
    await Promise.all([
      FeeBill.deleteMany({ companyId: req.companyId, studentId: student._id }),
      require('../models/ResultScore').deleteMany({ companyId: req.companyId, studentId: student._id }),
      AttendanceRecord.updateMany({ companyId: req.companyId }, { $pull: { records: { studentId: student._id } } }),
      student.deleteOne(),
    ]);
    emitSchool(io(req), req.companyId, 'students');
    res.status(200).json({ success: true, message: 'Student deleted.' });
  } catch (err) { next(err); }
};

// POST /school/students/promote — end of session. Moves a class's students
// (or the chosen ones) up to another class, or graduates them.
exports.promoteStudents = async (req, res, next) => {
  try {
    const { fromClassId, toClassId, graduate } = req.body;
    await assertClass(req.companyId, fromClassId);
    if (!fromClassId) return next(new AppError('Choose the class to promote from.', 400));
    if (!graduate) {
      await assertClass(req.companyId, toClassId);
      if (!toClassId) return next(new AppError('Choose the class to promote to, or graduate the students.', 400));
      if (String(toClassId) === String(fromClassId)) return next(new AppError('Pick a different class to promote to.', 400));
    }
    const filter = { companyId: req.companyId, classId: fromClassId, status: 'active' };
    if (Array.isArray(req.body.studentIds) && req.body.studentIds.length) {
      filter._id = { $in: req.body.studentIds.filter((id) => mongoose.isValidObjectId(id)) };
    }
    const update = graduate ? { status: 'graduated', leftAt: new Date() } : { classId: toClassId };
    const result = await Student.updateMany(filter, { $set: update });
    emitSchool(io(req), req.companyId, 'students');
    res.status(200).json({ success: true, data: { moved: result.modifiedCount } });
  } catch (err) { next(err); }
};

// ── Me & staff roles ─────────────────────────────────────────────────────
// GET /school/me — the signed-in user's school role and the classes and
// subjects they teach (drives the menu and teacher home screen).
exports.getMe = async (req, res, next) => {
  try {
    const me = String(req.user._id);
    const classes = await SchoolClass.find({ companyId: req.companyId, $or: [{ classTeacher: req.user._id }, { 'subjectTeachers.teacher': req.user._id }] })
      .sort({ level: 1, name: 1 }).select('name classTeacher subjectTeachers subjects').lean();
    res.status(200).json({
      success: true,
      data: {
        role: req.school.role,
        manager: req.school.manager,
        teaching: classes.map((c) => ({
          _id: c._id, name: c.name,
          classTeacher: String(c.classTeacher) === me,
          subjects: String(c.classTeacher) === me ? c.subjects : (c.subjectTeachers || []).filter((st) => String(st.teacher) === me).map((st) => st.subject),
        })),
      },
    });
  } catch (err) { next(err); }
};

// GET /school/staff — team members with their school role and assignments.
exports.getStaff = async (req, res, next) => {
  try {
    const [users, roles, classes] = await Promise.all([
      User.find({ companyId: req.companyId, status: { $ne: 'deleted' }, role: { $ne: 'customer' } }).select('name email role status').sort({ name: 1 }).lean(),
      SchoolStaff.find({ companyId: req.companyId }).lean(),
      SchoolClass.find({ companyId: req.companyId }).select('name classTeacher subjectTeachers').lean(),
    ]);
    const roleOf = new Map(roles.map((r) => [String(r.userId), r.role]));
    res.status(200).json({
      success: true,
      data: users.map((u) => {
        const id = String(u._id);
        const fullAccess = ['manager', 'company_owner', 'super_admin'].includes(u.role);
        return {
          _id: u._id, name: u.name, email: u.email, accountRole: u.role, status: u.status,
          schoolRole: fullAccess ? 'owner' : (roleOf.get(id) || null),
          classTeacherOf: classes.filter((c) => String(c.classTeacher) === id).map((c) => c.name),
          teaches: classes.flatMap((c) => (c.subjectTeachers || []).filter((st) => String(st.teacher) === id).map((st) => `${st.subject} (${c.name})`)),
        };
      }),
    });
  } catch (err) { next(err); }
};

// PUT /school/staff/:userId { role: admin|bursar|teacher|null }
exports.setStaffRole = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) return next(new AppError('Team member not found.', 404));
    const user = await User.findOne({ _id: userId, companyId: req.companyId }).select('role').lean();
    if (!user) return next(new AppError('Team member not found.', 404));
    if (['manager', 'company_owner', 'super_admin'].includes(user.role)) return next(new AppError('Owners and managers always have full access.', 400));
    const { role } = req.body;
    if (role == null || role === '') {
      await SchoolStaff.deleteOne({ companyId: req.companyId, userId });
    } else {
      if (!['admin', 'bursar', 'teacher'].includes(role)) return next(new AppError('Role must be admin, bursar or teacher.', 400));
      await SchoolStaff.findOneAndUpdate({ companyId: req.companyId, userId }, { $set: { role } }, { upsert: true });
    }
    emitSchool(io(req), req.companyId, 'staff', { userId });
    res.status(200).json({ success: true, data: { userId, role: role || null } });
  } catch (err) { next(err); }
};

// ── Admissions ───────────────────────────────────────────────────────────
function cleanApplication(body) {
  const data = pick(body, APPLICATION_FIELDS);
  if (data.guardian !== undefined) data.guardian = cleanGuardian(data.guardian);
  if (data.classAppliedFor === '') data.classAppliedFor = null;
  if (data.entranceScore === '') data.entranceScore = undefined;
  if (data.interviewDate === '') data.interviewDate = null;
  return data;
}

exports.getApplications = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.status) filter.status = req.query.status;
    if (mongoose.isValidObjectId(req.query.classId)) filter.classAppliedFor = req.query.classId;
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { applicationNumber: re }, { 'guardian.name': re }, { 'guardian.phone': re }, { 'guardian.email': re }];
    }
    const [applications, counts] = await Promise.all([
      AdmissionApplication.find(filter).sort({ createdAt: -1 }).limit(500).populate('classAppliedFor', 'name').lean(),
      AdmissionApplication.aggregate([{ $match: { companyId: oid(req.companyId) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    res.status(200).json({ success: true, data: applications, statusCounts: Object.fromEntries(counts.map((c) => [c._id, c.count])) });
  } catch (err) { next(err); }
};

async function createApplicationRecord(companyId, body, source) {
  const data = cleanApplication(body);
  if (!data.firstName || !data.lastName) throw new AppError('The child\'s first and last name are required.', 400);
  if (!data.guardian?.name || !data.guardian?.phone) throw new AppError('Parent/guardian name and phone are required.', 400);
  data.classAppliedFor = await assertClass(companyId, data.classAppliedFor);
  if (source === 'online') { delete data.entranceScore; delete data.interviewDate; delete data.notes; }
  const applicationNumber = await nextNumber(companyId, 'application');
  return AdmissionApplication.create({ ...data, companyId, applicationNumber, source });
}

exports.createApplication = async (req, res, next) => {
  try {
    const app = await createApplicationRecord(req.companyId, req.body, 'walk_in');
    emitSchool(io(req), req.companyId, 'admissions', { applicationId: app._id });
    res.status(201).json({ success: true, data: app });
  } catch (err) { next(err); }
};

exports.getApplication = async (req, res, next) => {
  try {
    const app = await findOwned(AdmissionApplication, req, req.params.id, 'Application');
    await app.populate([{ path: 'classAppliedFor', select: 'name' }, { path: 'decidedBy', select: 'name' }, { path: 'studentId', select: 'admissionNumber firstName lastName' }]);
    res.status(200).json({ success: true, data: app });
  } catch (err) { next(err); }
};

exports.updateApplication = async (req, res, next) => {
  try {
    const app = await findOwned(AdmissionApplication, req, req.params.id, 'Application');
    const data = cleanApplication(req.body);
    if (data.classAppliedFor !== undefined) data.classAppliedFor = await assertClass(req.companyId, data.classAppliedFor);
    // Workflow moves that aren't decisions (decisions go through /decision).
    if (['submitted', 'under_review', 'interview', 'withdrawn'].includes(req.body.status) && app.status !== 'enrolled') {
      data.status = req.body.status;
    } else if (data.interviewDate && ['submitted', 'under_review'].includes(app.status)) {
      data.status = 'interview';
    }
    Object.assign(app, data);
    await app.save();
    emitSchool(io(req), req.companyId, 'admissions', { applicationId: app._id });
    res.status(200).json({ success: true, data: app });
  } catch (err) { next(err); }
};

// POST /school/admissions/:id/decision { decision: admitted|rejected, notify }
exports.decideApplication = async (req, res, next) => {
  try {
    const app = await findOwned(AdmissionApplication, req, req.params.id, 'Application');
    const { decision } = req.body;
    if (!['admitted', 'rejected'].includes(decision)) return next(new AppError('Decision must be admitted or rejected.', 400));
    if (app.status === 'enrolled') return next(new AppError('This applicant is already enrolled.', 400));
    app.status = decision;
    app.decidedAt = new Date();
    app.decidedBy = req.user._id;
    if (req.body.notes) app.notes = [app.notes, String(req.body.notes).slice(0, 1000)].filter(Boolean).join('\n');
    await app.save();

    if (req.body.notify !== false && app.guardian?.email) {
      const settings = await getSettings(req.companyId);
      await app.populate('classAppliedFor', 'name');
      const child = escapeHtml(`${app.firstName} ${app.lastName}`);
      const body = decision === 'admitted'
        ? `<p>Dear ${escapeHtml(app.guardian.name)},</p><p>We are delighted to offer <b>${child}</b> admission${app.classAppliedFor ? ` into <b>${escapeHtml(app.classAppliedFor.name)}</b>` : ''} (application ${app.applicationNumber}).</p><p>Please contact the school office to complete enrolment.</p>`
        : `<p>Dear ${escapeHtml(app.guardian.name)},</p><p>Thank you for applying to our school for <b>${child}</b> (application ${app.applicationNumber}). After careful consideration we are unable to offer a place at this time.</p>`;
      sendGuardianEmail(app.guardian.email, `${settings.schoolName || 'Admission'}: application ${app.applicationNumber}`, emailShell(settings, body));
    }
    emitSchool(io(req), req.companyId, 'admissions', { applicationId: app._id });
    res.status(200).json({ success: true, data: app });
  } catch (err) { next(err); }
};

// POST /school/admissions/:id/enroll { classId, admissionNumber? } — turns an
// admitted application into a student (once) and bills this term's fees.
exports.enrollApplication = async (req, res, next) => {
  try {
    // Claim the application atomically so a double-click can't create two students.
    const app = await AdmissionApplication.findOneAndUpdate(
      { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null, companyId: req.companyId, status: 'admitted', studentId: null },
      { $set: { status: 'enrolled' } },
      { new: true },
    );
    if (!app) return next(new AppError('Only an admitted applicant who is not yet enrolled can be enrolled.', 400));
    let student;
    try {
      student = await createStudentRecord(req, {
        admissionNumber: req.body.admissionNumber,
        firstName: app.firstName, lastName: app.lastName, otherNames: app.otherNames,
        gender: app.gender, dateOfBirth: app.dateOfBirth,
        classId: req.body.classId || app.classAppliedFor,
        address: app.address, medicalNotes: app.medicalNotes, previousSchool: app.previousSchool,
        guardian: app.guardian?.toObject ? app.guardian.toObject() : app.guardian,
      }, { applicationId: app._id });
    } catch (e) {
      await AdmissionApplication.updateOne({ _id: app._id }, { $set: { status: 'admitted' } });
      throw e;
    }
    app.studentId = student._id;
    await app.save();
    emitSchool(io(req), req.companyId, 'admissions', { applicationId: app._id });
    emitSchool(io(req), req.companyId, 'students', { studentId: student._id });
    res.status(201).json({ success: true, data: { application: app, student } });
  } catch (err) { next(err); }
};

exports.deleteApplication = async (req, res, next) => {
  try {
    const app = await findOwned(AdmissionApplication, req, req.params.id, 'Application');
    if (app.status === 'enrolled') return next(new AppError('Enrolled applications are kept with the student record.', 400));
    await app.deleteOne();
    emitSchool(io(req), req.companyId, 'admissions');
    res.status(200).json({ success: true, message: 'Application deleted.' });
  } catch (err) { next(err); }
};

// ── Public: school info + online admission form ──────────────────────────
async function findSchoolBySlug(slug) {
  const settings = await SchoolSettings.findOne({ slug: String(slug || '').toLowerCase() });
  if (!settings) throw new AppError('School not found.', 404);
  return settings;
}
exports.findSchoolBySlug = findSchoolBySlug;

exports.getPublicSchool = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const Company = require('../models/Company');
    const [classes, company] = await Promise.all([
      SchoolClass.find({ companyId: settings.companyId, active: true }).sort({ level: 1, name: 1 }).select('name section').lean(),
      Company.findById(settings.companyId).select('paymentSettings.isPaymentSetup status').lean(),
    ]);
    if (!company || company.status !== 'active') return next(new AppError('School not found.', 404));
    res.status(200).json({
      success: true,
      data: {
        schoolName: settings.schoolName, motto: settings.motto, logo: settings.logo,
        address: settings.address, phone: settings.phone, email: settings.email,
        currentSession: settings.currentSession, currentTerm: settings.currentTerm,
        admissionsOpen: settings.admissionsOpen,
        onlinePayments: Boolean(settings.onlinePaymentsEnabled && company.paymentSettings?.isPaymentSetup),
        minimumOnlinePayment: settings.minimumOnlinePayment,
        classes,
      },
    });
  } catch (err) { next(err); }
};

exports.publicApply = async (req, res, next) => {
  try {
    // Honeypot: real parents never see or fill this field.
    if (req.body.website) return res.status(201).json({ success: true, data: { applicationNumber: 'received' } });
    const settings = await findSchoolBySlug(req.params.slug);
    if (!settings.admissionsOpen) return next(new AppError('Admissions are currently closed.', 400));
    const app = await createApplicationRecord(settings.companyId, req.body, 'online');
    emitSchool(io(req), settings.companyId, 'admissions', { applicationId: app._id, message: `New online application: ${app.firstName} ${app.lastName}` });
    io(req)?.to(`company:${settings.companyId}`).emit('notification:refresh', { type: 'school_application' });
    if (app.guardian?.email) {
      sendGuardianEmail(app.guardian.email, `Application received — ${app.applicationNumber}`, emailShell(settings,
        `<p>Dear ${escapeHtml(app.guardian.name)},</p><p>We have received the application for <b>${escapeHtml(`${app.firstName} ${app.lastName}`)}</b>. Your application number is <b>${app.applicationNumber}</b>. We will contact you about the next steps.</p>`));
    }
    res.status(201).json({ success: true, data: { applicationNumber: app.applicationNumber } });
  } catch (err) { next(err); }
};

exports._internal = { reserveNumbers, formatNumber, emailShell, sendGuardianEmail, escapeHtml };
