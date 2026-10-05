'use strict';

// Parent portal — a parent signs in with one child's admission number plus
// the phone/email the school holds for the guardian, and sees every child
// registered with that same contact: fees, payments, attendance and the
// report cards the school has published.

const mongoose = require('mongoose');
const Student = require('../models/Student');
const FeeBill = require('../models/FeeBill');
const FeePayment = require('../models/FeePayment');
const ResultScore = require('../models/ResultScore');
const AttendanceRecord = require('../models/AttendanceRecord');
const SchoolClass = require('../models/SchoolClass');
const { AppError } = require('../middleware/errorMiddleware');
const { round2, oid, signParentToken, readParentToken, TERMS } = require('../utils/school');
const { findSchoolBySlug } = require('./schoolController');
const { findStudentForParent } = require('./schoolFeeController');
const { buildReportCard, isPublished } = require('./schoolAcademicController');

const digits = (s) => String(s || '').replace(/\D/g, '');
const nameOf = (s) => [s.lastName, s.firstName, s.otherNames].filter(Boolean).join(' ');

async function childrenFor(companyId, studentIds) {
  const students = await Student.find({ _id: { $in: studentIds }, companyId }).populate('classId', 'name').sort({ lastName: 1, firstName: 1 }).lean();
  const owing = await FeeBill.aggregate([
    { $match: { companyId: oid(companyId), studentId: { $in: students.map((s) => s._id) }, status: { $in: ['unpaid', 'partial'] } } },
    { $group: { _id: '$studentId', balance: { $sum: { $max: ['$balance', 0] } } } },
  ]);
  const map = new Map(owing.map((o) => [String(o._id), o.balance]));
  return students.map((s) => ({
    _id: s._id, name: nameOf(s), firstName: s.firstName, admissionNumber: s.admissionNumber,
    className: s.classId?.name || null, status: s.status, outstanding: round2(map.get(String(s._id)) || 0),
  }));
}

// POST /school/public/:slug/portal/login { admissionNumber, contact }
exports.login = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const student = await findStudentForParent(settings.companyId, req.body.admissionNumber, req.body.contact);

    // Siblings: other current students with the same guardian contact.
    const c = String(req.body.contact).trim().toLowerCase();
    let siblings;
    if (c.includes('@')) {
      siblings = await Student.find({ companyId: settings.companyId, status: { $in: ['active', 'suspended'] }, 'guardian.email': c }).select('_id').lean();
    } else {
      const last10 = digits(c).slice(-10);
      const candidates = await Student.find({ companyId: settings.companyId, status: { $in: ['active', 'suspended'] }, 'guardian.phone': { $nin: [null, ''] } })
        .select('_id guardian.phone').lean();
      siblings = candidates.filter((s) => digits(s.guardian.phone).length >= 10 && digits(s.guardian.phone).slice(-10) === last10);
    }
    const ids = [...new Set([String(student._id), ...siblings.map((s) => String(s._id))])].slice(0, 20);
    res.status(200).json({
      success: true,
      data: {
        token: signParentToken(settings.companyId, ids),
        guardianName: student.guardian?.name || null,
        children: await childrenFor(settings.companyId, ids),
      },
    });
  } catch (err) { next(err); }
};

async function allowedStudent(req, settings) {
  const allowed = readParentToken(req, settings.companyId);
  const id = req.params.studentId;
  if (!mongoose.isValidObjectId(id) || !allowed.includes(String(id))) throw new AppError('Student not found.', 404);
  const student = await Student.findOne({ _id: id, companyId: settings.companyId }).populate('classId', 'name').lean();
  if (!student) throw new AppError('Student not found.', 404);
  return student;
}

// GET /school/public/:slug/portal/children — refresh the list (balances).
exports.getChildren = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const ids = readParentToken(req, settings.companyId);
    res.status(200).json({ success: true, data: await childrenFor(settings.companyId, ids) });
  } catch (err) { next(err); }
};

// GET /school/public/:slug/portal/children/:studentId
exports.getChild = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const student = await allowedStudent(req, settings);
    const companyId = settings.companyId;
    const [bills, payments, attendance, scoredTerms] = await Promise.all([
      FeeBill.find({ companyId, studentId: student._id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(30)
        .select('billNumber title session term items total discount amountPaid balance dueDate status').lean(),
      FeePayment.find({ companyId, studentId: student._id, voided: false }).sort({ paidAt: -1 }).limit(30)
        .select('receiptNumber amount method paidAt billId').lean(),
      AttendanceRecord.aggregate([
        { $match: { companyId: oid(companyId), session: settings.currentSession, term: settings.currentTerm, 'records.studentId': student._id } },
        { $unwind: '$records' }, { $match: { 'records.studentId': student._id } },
        { $group: { _id: '$records.status', count: { $sum: 1 } } },
      ]),
      ResultScore.aggregate([
        { $match: { companyId: oid(companyId), studentId: student._id } },
        { $group: { _id: { session: '$session', term: '$term', classId: '$classId' } } },
      ]),
    ]);
    // Only terms the school has published for the class the exams were in.
    const classNames = new Map((await SchoolClass.find({ _id: { $in: scoredTerms.map((t) => t._id.classId) } }).select('name').lean()).map((c) => [String(c._id), c.name]));
    const results = scoredTerms
      .filter((t) => isPublished(settings, t._id.classId, t._id.session, t._id.term))
      .map((t) => ({ session: t._id.session, term: t._id.term, className: classNames.get(String(t._id.classId)) || '' }))
      .sort((a, b) => (b.session.localeCompare(a.session)) || (TERMS.indexOf(b.term) - TERMS.indexOf(a.term)));
    const att = Object.fromEntries(attendance.map((a) => [a._id, a.count]));
    res.status(200).json({
      success: true,
      data: {
        student: { _id: student._id, name: nameOf(student), admissionNumber: student.admissionNumber, className: student.classId?.name || null, status: student.status },
        bills,
        outstanding: round2(bills.filter((b) => ['unpaid', 'partial'].includes(b.status)).reduce((s, b) => s + Math.max(0, b.balance), 0)),
        payments,
        attendance: { session: settings.currentSession, term: settings.currentTerm, present: att.present || 0, late: att.late || 0, absent: att.absent || 0, excused: att.excused || 0 },
        results,
      },
    });
  } catch (err) { next(err); }
};

// GET /school/public/:slug/portal/children/:studentId/report-card?session&term
exports.getReportCard = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const student = await allowedStudent(req, settings);
    const session = String(req.query.session || settings.currentSession);
    const term = TERMS.includes(req.query.term) ? req.query.term : settings.currentTerm;
    const card = await buildReportCard(settings.companyId, student._id, session, term, settings);
    if (!card.published || !card.summary) return next(new AppError('These results have not been released yet.', 404));
    res.status(200).json({ success: true, data: card });
  } catch (err) { next(err); }
};

// GET /school/public/:slug/portal/children/:studentId/schedule — the
// child's class timetable this term and upcoming exams.
exports.getSchedule = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const student = await allowedStudent(req, settings);
    const { scheduleForClass } = require('./schoolPlanController');
    res.status(200).json({ success: true, data: await scheduleForClass(settings.companyId, student.classId?._id, settings) });
  } catch (err) { next(err); }
};
