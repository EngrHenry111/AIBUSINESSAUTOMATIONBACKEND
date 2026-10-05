'use strict';

// Timetables and exam schedules.

const mongoose = require('mongoose');
const Timetable = require('../models/Timetable');
const ExamPaper = require('../models/ExamPaper');
const SchoolClass = require('../models/SchoolClass');
const SchoolSettings = require('../models/SchoolSettings');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { TERMS, getSettings, emitSchool, todayStr } = require('../utils/school');

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const io = (req) => req.app.get('io');
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

async function period(req, src = req.query) {
  const settings = await getSettings(req.companyId);
  return {
    settings,
    session: String(src.session || settings.currentSession),
    term: TERMS.includes(src.term) ? src.term : settings.currentTerm,
  };
}

async function findClass(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Choose a class.', 400);
  const cls = await SchoolClass.findOne({ _id: id, companyId: req.companyId }).populate('subjectTeachers.teacher', 'name').lean();
  if (!cls) throw new AppError('Class not found.', 404);
  return cls;
}

async function validTeachers(companyId, ids) {
  const list = [...new Set(ids.filter((id) => id && mongoose.isValidObjectId(id)).map(String))];
  const users = await User.find({ _id: { $in: list }, companyId }).select('name').lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
}

// ── Bell times ───────────────────────────────────────────────────────────
// PUT /school/timetable/periods { periods: [{ label, start, end, isBreak }] }
exports.updatePeriods = async (req, res, next) => {
  try {
    const periods = (Array.isArray(req.body.periods) ? req.body.periods : []).slice(0, 16).map((p) => ({
      label: String(p?.label || '').trim().slice(0, 20), start: String(p?.start || ''), end: String(p?.end || ''), isBreak: Boolean(p?.isBreak),
    }));
    if (!periods.length) return next(new AppError('Add at least one period.', 400));
    for (let i = 0; i < periods.length; i += 1) {
      const p = periods[i];
      if (!TIME.test(p.start) || !TIME.test(p.end) || p.start >= p.end) return next(new AppError(`Period ${i + 1}: enter a start time before the end time (HH:MM).`, 400));
      if (i > 0 && p.start < periods[i - 1].end) return next(new AppError(`Period ${i + 1} starts before period ${i} ends.`, 400));
      if (!p.label) p.label = p.isBreak ? 'Break' : String(periods.slice(0, i + 1).filter((x) => !x.isBreak).length);
    }
    const settings = await getSettings(req.companyId);
    // Shrinking the day drops timetable slots that no longer have a period.
    if (periods.length < settings.periods.length) {
      await Timetable.updateMany({ companyId: req.companyId }, { $pull: { slots: { period: { $gte: periods.length } } } });
    }
    await SchoolSettings.updateOne({ _id: settings._id }, { $set: { periods, periodsConfirmed: true } });
    emitSchool(io(req), req.companyId, 'timetable');
    res.status(200).json({ success: true, data: periods });
  } catch (err) { next(err); }
};

// ── Class timetable ──────────────────────────────────────────────────────
// GET /school/timetable?classId&session&term
exports.getTimetable = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.query.classId);
    const { settings, session, term } = await period(req);
    const tt = await Timetable.findOne({ companyId: req.companyId, classId: cls._id, session, term }).populate('slots.teacher', 'name').lean();
    res.status(200).json({
      success: true,
      data: {
        class: { _id: cls._id, name: cls.name, subjects: cls.subjects, subjectTeachers: (cls.subjectTeachers || []).map((st) => ({ subject: st.subject, teacher: st.teacher?._id, teacherName: st.teacher?.name })) },
        session, term, periods: settings.periods, slots: tt?.slots || [], updatedAt: tt?.updatedAt,
      },
    });
  } catch (err) { next(err); }
};

// PUT /school/timetable { classId, session, term, slots: [{ day, period, subject, teacher }] }
// Refuses a timetable that books a teacher into two classes at once.
exports.saveTimetable = async (req, res, next) => {
  try {
    const cls = await findClass(req, req.body.classId);
    const { settings, session, term } = await period(req, req.body);
    const periods = settings.periods || [];
    const raw = Array.isArray(req.body.slots) ? req.body.slots : [];
    const names = await validTeachers(req.companyId, raw.map((s) => s?.teacher));

    const seen = new Set();
    const slots = [];
    for (const s of raw) {
      const day = Number(s?.day); const p = Number(s?.period);
      const subject = String(s?.subject || '').trim().slice(0, 100);
      if (!subject) continue;
      if (!(day >= 1 && day <= 5) || !(p >= 0 && p < periods.length)) return next(new AppError('A lesson is outside the school week or bell times.', 400));
      if (periods[p].isBreak) return next(new AppError(`${periods[p].label} is a break — no lessons there.`, 400));
      const key = `${day}:${p}`;
      if (seen.has(key)) return next(new AppError(`Two lessons on ${DAYS[day]} period ${periods[p].label}.`, 400));
      seen.add(key);
      slots.push({ day, period: p, subject, teacher: names.has(String(s.teacher)) ? s.teacher : undefined });
    }

    // Teacher clashes with other classes' timetables this term.
    const teacherIds = [...new Set(slots.filter((s) => s.teacher).map((s) => String(s.teacher)))];
    const others = teacherIds.length ? await Timetable.find({
      companyId: req.companyId, session, term, classId: { $ne: cls._id }, 'slots.teacher': { $in: teacherIds },
    }).populate('classId', 'name').lean() : [];
    const clashes = [];
    for (const s of slots.filter((x) => x.teacher)) {
      for (const o of others) {
        const hit = o.slots.find((x) => String(x.teacher) === String(s.teacher) && x.day === s.day && x.period === s.period);
        if (hit) clashes.push(`${names.get(String(s.teacher))} already teaches ${o.classId?.name} ${hit.subject} on ${DAYS[s.day]}, period ${periods[s.period].label}`);
      }
    }
    if (clashes.length) return next(new AppError(`Clash: ${clashes.slice(0, 3).join('; ')}${clashes.length > 3 ? ` (+${clashes.length - 3} more)` : ''}.`, 409));

    const tt = await Timetable.findOneAndUpdate(
      { companyId: req.companyId, classId: cls._id, session, term },
      { $set: { slots, updatedBy: req.user._id } },
      { new: true, upsert: true },
    );
    emitSchool(io(req), req.companyId, 'timetable', { classId: cls._id });
    res.status(200).json({ success: true, data: tt });
  } catch (err) { next(err); }
};

// GET /school/timetable/teacher/:userId — one teacher's week across classes.
exports.getTeacherTimetable = async (req, res, next) => {
  try {
    const userId = req.params.userId === 'me' ? String(req.user._id) : req.params.userId;
    if (!mongoose.isValidObjectId(userId)) return next(new AppError('Teacher not found.', 404));
    if (req.school.role === 'teacher' && userId !== String(req.user._id)) return next(new AppError('You can only view your own timetable.', 403));
    const { settings, session, term } = await period(req);
    const teacher = await User.findOne({ _id: userId, companyId: req.companyId }).select('name').lean();
    if (!teacher) return next(new AppError('Teacher not found.', 404));
    const tts = await Timetable.find({ companyId: req.companyId, session, term, 'slots.teacher': userId }).populate('classId', 'name').lean();
    const slots = tts.flatMap((t) => t.slots.filter((s) => String(s.teacher) === userId).map((s) => ({ day: s.day, period: s.period, subject: s.subject, className: t.classId?.name })));
    res.status(200).json({ success: true, data: { teacher: { _id: teacher._id, name: teacher.name }, session, term, periods: settings.periods, slots, lessonsPerWeek: slots.length } });
  } catch (err) { next(err); }
};

// ── Exam schedule ────────────────────────────────────────────────────────
function cleanPaper(body) {
  const p = {
    subject: String(body.subject || '').trim().slice(0, 100),
    date: String(body.date || ''),
    start: String(body.start || ''),
    end: String(body.end || ''),
    venue: String(body.venue || '').trim().slice(0, 100),
    notes: String(body.notes || '').trim().slice(0, 300),
  };
  if (!p.subject) throw new AppError('Choose the subject.', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new AppError('Choose the exam date.', 400);
  if (!TIME.test(p.start) || !TIME.test(p.end) || p.start >= p.end) throw new AppError('Enter a start time before the end time.', 400);
  return p;
}

// Same class can't sit two papers at once; an invigilator can't be in two
// rooms at once (two classes in one hall with one invigilator is fine).
async function examClashes(companyId, session, term, papers, excludeId) {
  const dates = [...new Set(papers.map((p) => p.date))];
  const existing = await ExamPaper.find({ companyId, session, term, date: { $in: dates }, ...(excludeId && { _id: { $ne: excludeId } }) })
    .populate('classId', 'name').populate('invigilator', 'name').lean();
  const out = [];
  for (const p of papers) {
    for (const e of existing) {
      if (e.date !== p.date || !overlaps(e, p)) continue;
      if (String(e.classId?._id) === String(p.classId)) out.push(`${e.classId?.name} already sits ${e.subject} ${e.start}–${e.end} on ${e.date}`);
      else if (p.invigilator && String(e.invigilator?._id) === String(p.invigilator) && (e.venue || '') !== (p.venue || '')) {
        out.push(`${e.invigilator?.name} is invigilating ${e.classId?.name} ${e.subject} in ${e.venue || 'another room'} then`);
      }
    }
  }
  return out;
}

// GET /school/exams?session&term&classId&upcoming
exports.getExams = async (req, res, next) => {
  try {
    const { session, term } = await period(req);
    const filter = { companyId: req.companyId, session, term };
    if (mongoose.isValidObjectId(req.query.classId)) filter.classId = req.query.classId;
    if (req.query.upcoming === 'true') filter.date = { $gte: todayStr() };
    const papers = await ExamPaper.find(filter).sort({ date: 1, start: 1 }).populate('classId', 'name level').populate('invigilator', 'name').lean();
    res.status(200).json({ success: true, data: papers, session, term });
  } catch (err) { next(err); }
};

// POST /school/exams { classIds: [...], subject, date, start, end, venue, invigilator }
// One paper per class — set the same paper for every arm in one go.
exports.createExams = async (req, res, next) => {
  try {
    const { session, term } = await period(req, req.body);
    const base = cleanPaper(req.body);
    const ids = (Array.isArray(req.body.classIds) ? req.body.classIds : [req.body.classId]).filter((id) => mongoose.isValidObjectId(id));
    const classes = await SchoolClass.find({ _id: { $in: ids }, companyId: req.companyId }).select('_id').lean();
    if (!classes.length) return next(new AppError('Choose at least one class.', 400));
    const invigilator = (await validTeachers(req.companyId, [req.body.invigilator])).size ? req.body.invigilator : undefined;
    const papers = classes.map((c) => ({ ...base, companyId: req.companyId, session, term, classId: c._id, invigilator }));
    const clashes = await examClashes(req.companyId, session, term, papers);
    if (clashes.length) return next(new AppError(`Clash: ${clashes.slice(0, 3).join('; ')}.`, 409));
    const created = await ExamPaper.insertMany(papers);
    emitSchool(io(req), req.companyId, 'exams');
    res.status(201).json({ success: true, data: created });
  } catch (err) { next(err); }
};

exports.updateExam = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Exam not found.', 404));
    const paper = await ExamPaper.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!paper) return next(new AppError('Exam not found.', 404));
    const base = cleanPaper({ ...paper.toObject(), ...req.body });
    const invigilator = req.body.invigilator === undefined ? paper.invigilator
      : ((await validTeachers(req.companyId, [req.body.invigilator])).size ? req.body.invigilator : undefined);
    const next_ = { ...base, classId: paper.classId, invigilator };
    const clashes = await examClashes(req.companyId, paper.session, paper.term, [next_], paper._id);
    if (clashes.length) return next(new AppError(`Clash: ${clashes.slice(0, 3).join('; ')}.`, 409));
    Object.assign(paper, base, { invigilator });
    await paper.save();
    emitSchool(io(req), req.companyId, 'exams');
    res.status(200).json({ success: true, data: paper });
  } catch (err) { next(err); }
};

exports.deleteExam = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Exam not found.', 404));
    const r = await ExamPaper.deleteOne({ _id: req.params.id, companyId: req.companyId });
    if (!r.deletedCount) return next(new AppError('Exam not found.', 404));
    emitSchool(io(req), req.companyId, 'exams');
    res.status(200).json({ success: true, message: 'Exam removed.' });
  } catch (err) { next(err); }
};

// For the parent portal: the class's timetable this term and upcoming exams.
async function scheduleForClass(companyId, classId, settings) {
  if (!classId) return { periods: settings.periods, slots: [], exams: [] };
  const [tt, exams] = await Promise.all([
    Timetable.findOne({ companyId, classId, session: settings.currentSession, term: settings.currentTerm }).populate('slots.teacher', 'name').lean(),
    ExamPaper.find({ companyId, classId, session: settings.currentSession, term: settings.currentTerm, date: { $gte: todayStr() } }).sort({ date: 1, start: 1 }).select('subject date start end venue').lean(),
  ]);
  return {
    periods: settings.periods,
    slots: (tt?.slots || []).map((s) => ({ day: s.day, period: s.period, subject: s.subject, teacherName: s.teacher?.name })),
    exams,
  };
}
exports.scheduleForClass = scheduleForClass;
