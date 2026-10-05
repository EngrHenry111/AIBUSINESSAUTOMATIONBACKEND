'use strict';

const mongoose = require('mongoose');
const SchoolClass = require('../models/SchoolClass');
const Student = require('../models/Student');
const AttendanceRecord = require('../models/AttendanceRecord');
const ResultScore = require('../models/ResultScore');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const {
  TERMS, round2, oid, getSettings, gradeFor, ordinal, emitSchool, todayStr,
} = require('../utils/school');

const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'];
const io = (req) => req.app.get('io');
const nameOf = (s) => [s.lastName, s.firstName, s.otherNames].filter(Boolean).join(' ');

async function findClass(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Choose a class.', 400);
  const cls = await SchoolClass.findOne({ _id: id, companyId: req.companyId });
  if (!cls) throw new AppError('Class not found.', 404);
  return cls;
}

const classStudents = (companyId, classId) => Student.find({ companyId, classId, status: 'active' })
  .sort({ lastName: 1, firstName: 1 }).select('firstName lastName otherNames admissionNumber gender').lean();

async function periodFrom(req, source = req.query) {
  const settings = await getSettings(req.companyId);
  return {
    settings,
    session: source.session || settings.currentSession,
    term: TERMS.includes(source.term) ? source.term : settings.currentTerm,
  };
}

// ── Attendance ───────────────────────────────────────────────────────────
// GET /school/attendance?classId&date — the class register for a day.
exports.getRegister = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.query.classId);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
    const [students, record] = await Promise.all([
      classStudents(req.companyId, cls._id),
      AttendanceRecord.findOne({ companyId: req.companyId, classId: cls._id, date }).populate('takenBy', 'name').lean(),
    ]);
    const marks = new Map((record?.records || []).map((r) => [String(r.studentId), r]));
    res.status(200).json({
      success: true,
      data: {
        class: { _id: cls._id, name: cls.name }, date, taken: Boolean(record), takenBy: record?.takenBy, updatedAt: record?.updatedAt,
        students: students.map((s) => ({ ...s, name: nameOf(s), status: marks.get(String(s._id))?.status || null, note: marks.get(String(s._id))?.note || '' })),
      },
    });
  } catch (err) { next(err); }
};

// POST /school/attendance { classId, date, records: [{ studentId, status, note }] }
exports.saveRegister = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.body.classId);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : todayStr();
    if (date > todayStr()) return next(new AppError('You can\'t take attendance for a future date.', 400));
    const valid = new Set((await Student.find({ companyId: req.companyId, classId: cls._id }).select('_id').lean()).map((s) => String(s._id)));
    const records = (Array.isArray(req.body.records) ? req.body.records : [])
      .filter((r) => r && valid.has(String(r.studentId)) && ATTENDANCE_STATUSES.includes(r.status))
      .map((r) => ({ studentId: r.studentId, status: r.status, note: String(r.note || '').slice(0, 200) }));
    if (!records.length) return next(new AppError('Mark at least one student.', 400));
    const { settings } = await periodFrom(req);
    const record = await AttendanceRecord.findOneAndUpdate(
      { companyId: req.companyId, classId: cls._id, date },
      { $set: { records, takenBy: req.user._id, session: settings.currentSession, term: settings.currentTerm } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    emitSchool(io(req), req.companyId, 'attendance', { classId: cls._id, date });
    res.status(200).json({ success: true, data: record });
  } catch (err) { next(err); }
};

// GET /school/attendance/report?classId&from&to — per-student totals.
exports.getAttendanceReport = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.query.classId);
    const match = { companyId: oid(req.companyId), classId: cls._id };
    if (req.query.from || req.query.to) {
      match.date = {};
      if (req.query.from) match.date.$gte = req.query.from;
      if (req.query.to) match.date.$lte = req.query.to;
    } else {
      const { session, term } = await periodFrom(req);
      Object.assign(match, { session, term });
    }
    const [students, rows, days] = await Promise.all([
      classStudents(req.companyId, cls._id),
      AttendanceRecord.aggregate([
        { $match: match }, { $unwind: '$records' },
        { $group: { _id: { s: '$records.studentId', st: '$records.status' }, count: { $sum: 1 } } },
      ]),
      AttendanceRecord.countDocuments(match),
    ]);
    const by = new Map();
    rows.forEach((r) => {
      const k = String(r._id.s);
      by.set(k, { ...(by.get(k) || {}), [r._id.st]: r.count });
    });
    res.status(200).json({
      success: true,
      data: {
        class: { _id: cls._id, name: cls.name }, days,
        students: students.map((s) => {
          const c = by.get(String(s._id)) || {};
          const attended = (c.present || 0) + (c.late || 0);
          const marked = attended + (c.absent || 0) + (c.excused || 0);
          return { _id: s._id, name: nameOf(s), admissionNumber: s.admissionNumber, present: c.present || 0, late: c.late || 0, absent: c.absent || 0, excused: c.excused || 0, rate: marked ? Math.round((attended / marked) * 100) : null };
        }),
      },
    });
  } catch (err) { next(err); }
};

// ── Results ──────────────────────────────────────────────────────────────
// GET /school/results/sheet?classId&subject&session&term — score entry grid.
exports.getScoreSheet = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.query.classId);
    const { settings, session, term } = await periodFrom(req);
    const subject = String(req.query.subject || '').trim();
    if (!subject) return next(new AppError('Choose a subject.', 400));
    const [students, scores] = await Promise.all([
      classStudents(req.companyId, cls._id),
      ResultScore.find({ companyId: req.companyId, classId: cls._id, session, term, subject }).lean(),
    ]);
    const map = new Map(scores.map((s) => [String(s.studentId), s]));
    res.status(200).json({
      success: true,
      data: {
        class: { _id: cls._id, name: cls.name, subjects: cls.subjects }, subject, session, term,
        caMax: settings.caMax, examMax: 100 - settings.caMax,
        students: students.map((s) => {
          const sc = map.get(String(s._id));
          return { _id: s._id, name: nameOf(s), admissionNumber: s.admissionNumber, ca: sc?.ca ?? null, exam: sc?.exam ?? null, total: sc?.total ?? null, grade: sc?.grade || null };
        }),
      },
    });
  } catch (err) { next(err); }
};

// POST /school/results/sheet { classId, subject, session, term, scores: [{ studentId, ca, exam }] }
exports.saveScoreSheet = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.body.classId);
    const { settings, session, term } = await periodFrom(req, req.body);
    const subject = String(req.body.subject || '').trim().slice(0, 100);
    if (!subject) return next(new AppError('Choose a subject.', 400));
    const caMax = settings.caMax;
    const examMax = 100 - caMax;
    const valid = new Set((await Student.find({ companyId: req.companyId, classId: cls._id }).select('_id').lean()).map((s) => String(s._id)));

    const ops = [];
    const removals = [];
    const errors = [];
    for (const row of Array.isArray(req.body.scores) ? req.body.scores : []) {
      if (!row || !valid.has(String(row.studentId))) continue;
      const blank = (v) => v === '' || v == null;
      if (blank(row.ca) && blank(row.exam)) { removals.push(row.studentId); continue; }
      const ca = round2(row.ca || 0);
      const exam = round2(row.exam || 0);
      if (ca < 0 || ca > caMax || exam < 0 || exam > examMax) { errors.push(String(row.studentId)); continue; }
      const total = round2(ca + exam);
      const { grade, remark } = gradeFor(settings.gradingScale, total);
      ops.push({
        updateOne: {
          filter: { companyId: req.companyId, studentId: row.studentId, session, term, subject },
          update: { $set: { classId: cls._id, ca, exam, total, grade, remark, enteredBy: req.user._id } },
          upsert: true,
        },
      });
    }
    if (errors.length) return next(new AppError(`CA must be 0–${caMax} and exam 0–${examMax}. Check ${errors.length} row(s).`, 400));
    if (ops.length) await ResultScore.bulkWrite(ops, { ordered: false });
    if (removals.length) await ResultScore.deleteMany({ companyId: req.companyId, studentId: { $in: removals }, session, term, subject });
    emitSchool(io(req), req.companyId, 'results', { classId: cls._id, subject });
    res.status(200).json({ success: true, data: { saved: ops.length, cleared: removals.length } });
  } catch (err) { next(err); }
};

// Every student in the class with their subject totals, average and
// position. Ties share a position ("1st, 1st, 3rd").
async function classRanking(companyId, classId, session, term) {
  const scores = await ResultScore.find({ companyId, classId, session, term }).lean();
  const byStudent = new Map();
  for (const s of scores) {
    const k = String(s.studentId);
    if (!byStudent.has(k)) byStudent.set(k, []);
    byStudent.get(k).push(s);
  }
  const ranked = [...byStudent.entries()].map(([studentId, list]) => {
    const total = round2(list.reduce((a, s) => a + s.total, 0));
    return { studentId, scores: list, total, subjects: list.length, average: list.length ? round2(total / list.length) : 0 };
  }).sort((a, b) => b.average - a.average);
  ranked.forEach((r, i) => { r.position = i > 0 && r.average === ranked[i - 1].average ? ranked[i - 1].position : i + 1; });

  // Per-subject class stats for the report card.
  const subjectStats = {};
  for (const s of scores) {
    const st = subjectStats[s.subject] || (subjectStats[s.subject] = { highest: 0, lowest: 100, sum: 0, n: 0 });
    st.highest = Math.max(st.highest, s.total); st.lowest = Math.min(st.lowest, s.total); st.sum += s.total; st.n += 1;
  }
  Object.values(subjectStats).forEach((st) => { st.average = st.n ? round2(st.sum / st.n) : 0; delete st.sum; });
  return { ranked, subjectStats };
}

// GET /school/results/broadsheet?classId&session&term
exports.getBroadsheet = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.query.classId);
    const { session, term } = await periodFrom(req);
    const [students, { ranked }] = await Promise.all([
      classStudents(req.companyId, cls._id),
      classRanking(req.companyId, cls._id, session, term),
    ]);
    const rankMap = new Map(ranked.map((r) => [r.studentId, r]));
    const subjects = [...new Set([...(cls.subjects || []), ...ranked.flatMap((r) => r.scores.map((s) => s.subject))])];
    res.status(200).json({
      success: true,
      data: {
        class: { _id: cls._id, name: cls.name }, session, term, subjects,
        rows: students.map((s) => {
          const r = rankMap.get(String(s._id));
          return {
            _id: s._id, name: nameOf(s), admissionNumber: s.admissionNumber,
            scores: Object.fromEntries((r?.scores || []).map((x) => [x.subject, x.total])),
            total: r?.total ?? null, average: r?.average ?? null,
            position: r ? ordinal(r.position) : null,
          };
        }).sort((a, b) => (b.average ?? -1) - (a.average ?? -1)),
      },
    });
  } catch (err) { next(err); }
};

// GET /school/results/report-card/:studentId?session&term
exports.getReportCard = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.studentId)) return next(new AppError('Student not found.', 404));
    const student = await Student.findOne({ _id: req.params.studentId, companyId: req.companyId }).populate('classId', 'name').lean();
    if (!student) return next(new AppError('Student not found.', 404));
    const { settings, session, term } = await periodFrom(req);

    // The class the student sat this term's exams in — from the scores,
    // which survives a later promotion.
    const anyScore = await ResultScore.findOne({ companyId: req.companyId, studentId: student._id, session, term }).select('classId').lean();
    const classId = anyScore?.classId || student.classId?._id;
    if (!classId) return next(new AppError('This student has no class or results for that term.', 400));
    const [cls, { ranked, subjectStats }, attendance] = await Promise.all([
      SchoolClass.findById(classId).select('name').populate('classTeacher', 'name').lean(),
      classRanking(req.companyId, classId, session, term),
      AttendanceRecord.aggregate([
        { $match: { companyId: oid(req.companyId), session, term, 'records.studentId': student._id } },
        { $unwind: '$records' }, { $match: { 'records.studentId': student._id } },
        { $group: { _id: '$records.status', count: { $sum: 1 } } },
      ]),
    ]);
    const mine = ranked.find((r) => r.studentId === String(student._id));
    const att = Object.fromEntries(attendance.map((a) => [a._id, a.count]));
    res.status(200).json({
      success: true,
      data: {
        school: pick(settings.toObject(), ['schoolName', 'motto', 'address', 'phone', 'email', 'logo']),
        student: { _id: student._id, name: nameOf(student), admissionNumber: student.admissionNumber, gender: student.gender, dateOfBirth: student.dateOfBirth },
        class: { name: cls?.name, teacher: cls?.classTeacher?.name },
        session, term, caMax: settings.caMax, gradingScale: settings.gradingScale,
        subjects: (mine?.scores || []).sort((a, b) => a.subject.localeCompare(b.subject)).map((s) => ({
          subject: s.subject, ca: s.ca, exam: s.exam, total: s.total, grade: s.grade, remark: s.remark, classStats: subjectStats[s.subject],
        })),
        summary: mine ? {
          total: mine.total, average: mine.average, subjects: mine.subjects,
          position: ordinal(mine.position), classSize: ranked.length, grade: gradeFor(settings.gradingScale, mine.average),
        } : null,
        attendance: { present: (att.present || 0) + (att.late || 0), absent: att.absent || 0, excused: att.excused || 0 },
      },
    });
  } catch (err) { next(err); }
};
