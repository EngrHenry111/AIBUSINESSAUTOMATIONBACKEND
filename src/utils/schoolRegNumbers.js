'use strict';

// Class register numbers — counted per class LEVEL per SESSION, never across
// the whole school. All arms of a level (JSS 1A, 1B, 1C) share one count, so
// a JSS 1 of 120 students runs 001–120 and JSS 2 starts again at 001. A new
// session issues fresh numbers in alphabetical order; students who join
// mid-session take the next number. The permanent admission number is
// untouched — parents still use it to pay fees and sign in.
//
// The ledger (StudentEnrolment) is the source of truth; Student.regNumber is
// a copy of the current session's number for lists and search.

const Student = require('../models/Student');
const SchoolClass = require('../models/SchoolClass');
const StudentEnrolment = require('../models/StudentEnrolment');
const SchoolRegCounter = require('../models/SchoolRegCounter');
const { getSettings, oid } = require('./school');

const DEFAULT_FORMAT = '{PREFIX}/{LEVEL}/{SESSION}/{SERIAL}';
const TOKENS = ['PREFIX', 'LEVEL', 'SESSION', 'START', 'SERIAL'];
const NAME_FIELDS = 'firstName lastName otherNames status classId';

// "JSS 1A" → JSS1, "Primary 4 Gold" → PRIMARY4, "SS 2 Science A" → SS2.
// Names without a digit ("Creche") are used whole.
function deriveLevelCode(name) {
  const flat = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = flat.match(/^(.*\d)[A-Z]*$/);
  return ((m ? m[1] : flat) || 'CLASS').slice(0, 12);
}
const levelCodeOf = (cls) => (cls?.levelCode || deriveLevelCode(cls?.name));

function validateFormat(format) {
  const f = String(format || '');
  const unknown = (f.match(/\{[^}]*\}/g) || []).map((t) => t.slice(1, -1)).filter((t) => !TOKENS.includes(t));
  if (unknown.length) return `Unknown part {${unknown[0]}}. Use ${TOKENS.map((t) => `{${t}}`).join(' ')}.`;
  if (!f.includes('{SERIAL}') || !f.includes('{LEVEL}')) return 'The format must include {LEVEL} and {SERIAL}.';
  return null;
}

const widthFor = (n) => Math.max(3, String(n).length);

function formatReg(settings, session, levelCode, serial, width) {
  return (settings.regNumberFormat || DEFAULT_FORMAT)
    .replace(/\{PREFIX\}/g, settings.admissionNumberPrefix || 'STU')
    .replace(/\{LEVEL\}/g, levelCode)
    .replace(/\{SESSION\}/g, String(session).replace('/', '-'))
    .replace(/\{START\}/g, String(session).slice(0, 4))
    .replace(/\{SERIAL\}/g, String(serial).padStart(width, '0'));
}

const byName = (a, b) => ['lastName', 'firstName', 'otherNames']
  .reduce((r, k) => r || String(a[k] || '').localeCompare(String(b[k] || ''), undefined, { sensitivity: 'base' }), 0);

async function classLevels(companyId) {
  const classes = await SchoolClass.find({ companyId }).select('name levelCode').lean();
  return new Map(classes.map((c) => [String(c._id), levelCodeOf(c)]));
}

// Copies the session's numbers onto the Student records — only for the
// current session, since lists always show this session's number.
async function syncStudents(companyId, session, settings, studentIds) {
  if (session !== settings.currentSession || !studentIds.length) return;
  const rows = await StudentEnrolment.find({ companyId, session, studentId: { $in: studentIds } }).select('studentId regNumber').lean();
  if (!rows.length) return;
  await Student.bulkWrite(rows.map((r) => ({
    updateOne: { filter: { _id: r.studentId, companyId }, update: { $set: { regNumber: r.regNumber, regSession: session } } },
  })));
}

async function insertEnrolments(docs) {
  if (!docs.length) return;
  try {
    await StudentEnrolment.insertMany(docs, { ordered: false });
  } catch (err) {
    // A parallel request already numbered some of these students.
    if (err.code !== 11000 && !err.writeErrors) throw err;
  }
}

// Issues numbers for the given students in `session` (default: current).
// Students who already hold a number for their level keep it; a student
// whose level changed gets a new one in the new level.
async function issue(companyId, studentIds, session) {
  const settings = await getSettings(companyId);
  const sess = session || settings.currentSession;
  const levels = await classLevels(companyId);
  const students = await Student.find({ companyId, _id: { $in: studentIds }, status: 'active', classId: { $ne: null } })
    .select(NAME_FIELDS).lean();
  if (!students.length) return 0;
  const existing = new Map((await StudentEnrolment.find({ companyId, session: sess, studentId: { $in: students.map((s) => s._id) } })
    .select('studentId levelCode classId').lean()).map((e) => [String(e.studentId), e]));

  const stale = [];
  const armMoves = [];
  const byLevel = new Map();
  for (const s of students) {
    const level = levels.get(String(s.classId));
    if (!level) continue;
    const held = existing.get(String(s._id));
    if (held && held.levelCode === level) {
      if (String(held.classId) !== String(s.classId)) armMoves.push({ updateOne: { filter: { _id: held._id }, update: { $set: { classId: s.classId } } } });
      continue;
    }
    if (held) stale.push(held._id);
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(s);
  }
  if (stale.length) await StudentEnrolment.deleteMany({ _id: { $in: stale } });
  if (armMoves.length) await StudentEnrolment.bulkWrite(armMoves);

  let issued = 0;
  for (const [levelCode, list] of byLevel) {
    list.sort(byName);
    // eslint-disable-next-line no-await-in-loop
    const counter = await SchoolRegCounter.findOneAndUpdate(
      { companyId, session: sess, levelCode }, { $inc: { seq: list.length } }, { upsert: true, new: true },
    ).lean();
    const first = counter.seq - list.length + 1;
    const width = widthFor(counter.seq);
    // eslint-disable-next-line no-await-in-loop
    await insertEnrolments(list.map((s, i) => ({
      companyId, session: sess, studentId: s._id, classId: s.classId, levelCode,
      serial: first + i, regNumber: formatReg(settings, sess, levelCode, first + i, width),
    })));
    issued += list.length;
  }
  await syncStudents(companyId, sess, settings, students.map((s) => s._id));
  return issued;
}

// Every active student in a class who has no number for `session` yet.
async function issueMissing(companyId, session) {
  const ids = await Student.find({ companyId, status: 'active', classId: { $ne: null } }).distinct('_id');
  return issue(companyId, ids, session);
}

// Rebuilds a level's numbers for a session from 001, alphabetically: current
// students first, then those who left during the session (they keep a place
// so their report cards still carry a number).
async function renumberLevel(companyId, levelCode, session) {
  const settings = await getSettings(companyId);
  const sess = session || settings.currentSession;
  const levels = await classLevels(companyId);
  const classIds = [...levels].filter(([, l]) => l === levelCode).map(([id]) => id);
  const [active, held] = await Promise.all([
    Student.find({ companyId, status: 'active', classId: { $in: classIds } }).select(NAME_FIELDS).lean(),
    StudentEnrolment.find({ companyId, session: sess, levelCode }).select('studentId classId').lean(),
  ]);
  const activeIds = new Set(active.map((s) => String(s._id)));
  const heldClass = new Map(held.map((e) => [String(e.studentId), e.classId]));
  const others = await Student.find({ companyId, _id: { $in: held.map((e) => e.studentId).filter((id) => !activeIds.has(String(id))) } })
    .select(NAME_FIELDS).lean();
  const leavers = others.filter((s) => s.status !== 'active');
  const movedAway = others.filter((s) => s.status === 'active').map((s) => s._id);

  const list = [...active.sort(byName), ...leavers.sort(byName)];
  await StudentEnrolment.deleteMany({ companyId, session: sess, $or: [{ levelCode }, { studentId: { $in: active.map((s) => s._id) } }] });
  await SchoolRegCounter.updateOne({ companyId, session: sess, levelCode }, { $set: { seq: list.length } }, { upsert: true });
  const width = widthFor(list.length);
  await insertEnrolments(list.map((s, i) => ({
    companyId, session: sess, studentId: s._id, classId: activeIds.has(String(s._id)) ? s.classId : heldClass.get(String(s._id)), levelCode,
    serial: i + 1, regNumber: formatReg(settings, sess, levelCode, i + 1, width),
  })));
  await syncStudents(companyId, sess, settings, list.map((s) => s._id));
  if (movedAway.length) await issue(companyId, movedAway, sess);
  return { levelCode, count: active.length, leavers: leavers.length };
}

// After the format or prefix changes: same serials, new wording.
async function reformatSession(companyId, session) {
  const settings = await getSettings(companyId);
  const sess = session || settings.currentSession;
  const rows = await StudentEnrolment.find({ companyId, session: sess }).select('levelCode serial studentId').lean();
  if (!rows.length) return 0;
  const maxSerial = new Map();
  rows.forEach((r) => maxSerial.set(r.levelCode, Math.max(maxSerial.get(r.levelCode) || 0, r.serial)));
  // Two passes so a new number can't collide with another row's old one.
  await StudentEnrolment.bulkWrite(rows.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { regNumber: `~${r._id}` } } } })));
  await StudentEnrolment.bulkWrite(rows.map((r) => ({
    updateOne: { filter: { _id: r._id }, update: { $set: { regNumber: formatReg(settings, sess, r.levelCode, r.serial, widthFor(maxSerial.get(r.levelCode))) } } },
  })));
  await syncStudents(companyId, sess, settings, rows.map((r) => r.studentId));
  return rows.length;
}

// The school moved to a new current session: lists stop showing last
// session's numbers and everyone in a class is numbered for the new one.
async function activateSession(companyId) {
  const settings = await getSettings(companyId);
  const session = settings.currentSession;
  await Student.updateMany({ companyId, regSession: { $ne: session } }, { $unset: { regNumber: 1, regSession: 1 } });
  const issued = await issueMissing(companyId, session);
  const held = await StudentEnrolment.find({ companyId, session }).distinct('studentId');
  await syncStudents(companyId, session, settings, held);
  return issued;
}

// Per-level overview for the settings screen.
async function summary(companyId, session) {
  const settings = await getSettings(companyId);
  const sess = session || settings.currentSession;
  const classes = await SchoolClass.find({ companyId, active: true }).sort({ level: 1, name: 1 }).select('name levelCode level').lean();
  const [counts, issued] = await Promise.all([
    Student.aggregate([{ $match: { companyId: oid(companyId), status: 'active' } }, { $group: { _id: '$classId', n: { $sum: 1 } } }]),
    StudentEnrolment.aggregate([{ $match: { companyId: oid(companyId), session: sess } }, { $group: { _id: '$levelCode', n: { $sum: 1 }, max: { $max: '$serial' } } }]),
  ]);
  const countOf = new Map(counts.map((c) => [String(c._id), c.n]));
  const issuedOf = new Map(issued.map((i) => [i._id, i]));
  const missing = await Student.countDocuments({ companyId, status: 'active', classId: { $ne: null }, regSession: { $ne: sess } });
  const levels = new Map();
  for (const c of classes) {
    const code = levelCodeOf(c);
    const row = levels.get(code) || { levelCode: code, classes: [], students: 0, issued: issuedOf.get(code)?.n || 0, highest: issuedOf.get(code)?.max || 0 };
    row.classes.push(c.name);
    row.students += countOf.get(String(c._id)) || 0;
    levels.set(code, row);
  }
  return {
    session: sess,
    format: settings.regNumberFormat || DEFAULT_FORMAT,
    missing: sess === settings.currentSession ? missing : null,
    levels: [...levels.values()].map((l) => ({
      ...l,
      // More numbers out than students = gaps from moves or leavers.
      hasGaps: l.highest > l.students,
      sample: formatReg(settings, sess, l.levelCode, 1, widthFor(Math.max(l.students, l.highest, 1))),
    })),
  };
}

async function history(companyId, studentId) {
  return StudentEnrolment.find({ companyId, studentId }).sort({ session: -1 })
    .select('session regNumber serial levelCode classId').populate('classId', 'name').lean();
}

async function regNumberFor(companyId, studentId, session) {
  const row = await StudentEnrolment.findOne({ companyId, studentId, session }).select('regNumber').lean();
  return row?.regNumber || null;
}

module.exports = {
  DEFAULT_FORMAT, TOKENS, deriveLevelCode, levelCodeOf, validateFormat, formatReg,
  issue, issueMissing, renumberLevel, reformatSession, activateSession, summary, history, regNumberFor,
};
