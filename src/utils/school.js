'use strict';

// Shared plumbing for the school module: per-school settings, atomic
// document numbers, grading, live updates and the fee-bill arithmetic that
// every payment path (desk, online, webhook) goes through.

const crypto = require('crypto');
const mongoose = require('mongoose');
const SchoolSettings = require('../models/SchoolSettings');
const FeeBill = require('../models/FeeBill');
const FeeStructure = require('../models/FeeStructure');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');

const TERMS = ['first', 'second', 'third'];
const TERM_LABEL = { first: 'First term', second: 'Second term', third: 'Third term' };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const slugify = (s) => String(s || 'school').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'school';

// Settings are created lazily the first time a school opens the module.
async function getSettings(companyId) {
  const existing = await SchoolSettings.findOne({ companyId });
  if (existing) return existing;

  const company = await Company.findById(companyId).select('companyName email phone address').lean();
  const base = slugify(company?.companyName);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await SchoolSettings.create({
        companyId,
        slug,
        schoolName: company?.companyName,
        email: company?.email,
        phone: company?.phone,
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Either the slug is taken, or a parallel request just created this
      // school's settings — in which case use those.
      // eslint-disable-next-line no-await-in-loop
      const raced = await SchoolSettings.findOne({ companyId });
      if (raced) return raced;
    }
  }
  throw new AppError('Could not set up school settings. Please try again.', 500);
}

// Reserves `count` consecutive numbers from a counter and returns the first.
async function reserveNumbers(companyId, counter, count = 1) {
  await getSettings(companyId);
  const s = await SchoolSettings.findOneAndUpdate(
    { companyId },
    { $inc: { [`counters.${counter}`]: count } },
    { new: true, projection: { counters: 1, admissionNumberPrefix: 1 } },
  ).lean();
  return { first: s.counters[counter] - count + 1, prefix: s.admissionNumberPrefix || 'STU' };
}

const pad = (n, w = 4) => String(n).padStart(w, '0');
const year = () => new Date().getFullYear();
const formatNumber = {
  application: (n) => `APP-${year()}-${pad(n)}`,
  admission: (n, prefix) => `${prefix}/${year()}/${pad(n)}`,
  bill: (n) => `FEE-${pad(n, 6)}`,
  receipt: (n) => `RCT-${pad(n, 6)}`,
};

async function nextNumber(companyId, counter) {
  const { first, prefix } = await reserveNumbers(companyId, counter, 1);
  return formatNumber[counter](first, prefix);
}

function gradeFor(scale, total) {
  const sorted = [...(scale || SchoolSettings.DEFAULT_GRADES)].sort((a, b) => b.min - a.min);
  const g = sorted.find((x) => total >= x.min) || sorted[sorted.length - 1];
  return { grade: g?.grade || '', remark: g?.remark || '' };
}

// "1st", "2nd", "3rd", "11th"…
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Everyone in the school's company room refreshes what they are looking at.
function emitSchool(io, companyId, kind, data = {}) {
  io?.to(`company:${companyId}`).emit('school:update', { kind, ...data, at: Date.now() });
}

// Today in the school's timezone (Africa/Lagos by default) as YYYY-MM-DD.
function todayStr(tz = process.env.SCHOOL_TZ || 'Africa/Lagos') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ── Fee bills ─────────────────────────────────────────────────────────────

// Creates this structure's bill for every student given who doesn't already
// have one. Safe to re-run: the unique (studentId, feeStructureId) index
// drops duplicates, including from a concurrent run.
async function billStudents(structure, students, userId) {
  if (!students.length) return 0;
  const already = new Set((await FeeBill.find({
    feeStructureId: structure._id, studentId: { $in: students.map((s) => s._id) },
  }).distinct('studentId')).map(String));
  const todo = students.filter((s) => !already.has(String(s._id)));
  if (!todo.length) return 0;

  const items = structure.items.map((i) => ({ name: i.name, amount: round2(i.amount) }));
  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const { first } = await reserveNumbers(structure.companyId, 'bill', todo.length);
  const docs = todo.map((st, i) => ({
    companyId: structure.companyId,
    billNumber: formatNumber.bill(first + i),
    studentId: st._id,
    classId: st.classId,
    feeStructureId: structure._id,
    title: structure.name,
    session: structure.session,
    term: structure.term,
    items,
    subtotal,
    total: subtotal,
    balance: subtotal,
    status: subtotal > 0 ? 'unpaid' : 'paid',
    dueDate: structure.dueDate,
    createdBy: userId,
  }));
  try {
    const res = await FeeBill.insertMany(docs, { ordered: false });
    return res.length;
  } catch (err) {
    if (err.code === 11000 || err.writeErrors) return err.insertedDocs?.length ?? (docs.length - (err.writeErrors?.length || 0));
    throw err;
  }
}

// A newly enrolled student picks up this term's bills for their class.
async function billNewStudent(student, userId) {
  const settings = await getSettings(student.companyId);
  const structures = await FeeStructure.find({
    companyId: student.companyId,
    session: settings.currentSession,
    term: settings.currentTerm,
    active: true,
    autoApplyToNewStudents: true,
    $or: [{ classIds: { $size: 0 } }, { classIds: student.classId }],
  });
  let n = 0;
  // eslint-disable-next-line no-await-in-loop
  for (const s of structures) n += await billStudents(s, [student], userId);
  return n;
}

// Bill status follows its numbers; waived/cancelled bills stay as they are.
const STATUS_EXPR = {
  $cond: [
    { $in: ['$status', ['waived', 'cancelled']] }, '$status',
    { $cond: [{ $lte: ['$balance', 0] }, 'paid', { $cond: [{ $gt: ['$amountPaid', 0] }, 'partial', 'unpaid'] }] },
  ],
};

/**
 * Moves money onto (or, with a negative amount, back off) a bill in one
 * atomic update. With `guard`, the update only matches while the bill still
 * owes at least `amount` — so two bursars can't both take the last ₦50,000.
 * Returns the updated bill, or null if the guard (or bill state) refused it.
 */
async function applyToBill(companyId, billId, amount, { guard = false } = {}) {
  const amt = round2(amount);
  const filter = { _id: billId, companyId };
  if (guard) {
    filter.status = { $in: ['unpaid', 'partial'] };
    filter.balance = { $gte: amt - 0.001 };
  }
  return FeeBill.findOneAndUpdate(filter, [
    { $set: {
      amountPaid: { $round: [{ $add: ['$amountPaid', amt] }, 2] },
      balance: { $round: [{ $subtract: ['$balance', amt] }, 2] },
    } },
    { $set: { status: STATUS_EXPR } },
  ], { new: true });
}

// Discount changes recompute total/balance from the bill's CURRENT
// amountPaid inside the same update, so a payment landing at the same
// moment can't be lost.
async function setBillDiscount(companyId, billId, discount, reason) {
  const d = Math.max(0, round2(discount));
  return FeeBill.findOneAndUpdate(
    { _id: billId, companyId, status: { $nin: ['waived', 'cancelled'] }, subtotal: { $gte: d } },
    [
      { $set: {
        discount: d,
        discountReason: reason || '',
        total: { $round: [{ $subtract: ['$subtotal', d] }, 2] },
        balance: { $round: [{ $subtract: [{ $subtract: ['$subtotal', d] }, '$amountPaid'] }, 2] },
      } },
      { $set: { status: STATUS_EXPR } },
    ],
    { new: true },
  );
}

// ── Parent portal session ─────────────────────────────────────────────────
// A short-lived token naming the children a parent proved access to. Signed
// with a key derived from JWT_SECRET so it can never pass as a staff token.
// Errors are 400 + code PORTAL_EXPIRED, never 401: the frontend treats any
// 401 as "staff session over" and redirects to the staff login page.
const jwt = require('jsonwebtoken');
const PARENT_TTL = '2h';
const parentKey = () => `${process.env.JWT_SECRET}:school-parent`;

function signParentToken(companyId, studentIds) {
  return jwt.sign({ sp: 1, c: String(companyId), s: studentIds.map(String) }, parentKey(), { expiresIn: PARENT_TTL });
}

// Returns the student ids the parent may see, for this school only.
function readParentToken(req, companyId) {
  const raw = req.headers['x-parent-token'];
  const expired = () => new AppError('Your session has ended. Please sign in again.', 400, 'PORTAL_EXPIRED');
  if (!raw) throw expired();
  let d;
  try { d = jwt.verify(String(raw), parentKey()); } catch { throw expired(); }
  if (d?.sp !== 1 || d.c !== String(companyId) || !Array.isArray(d.s)) throw expired();
  return d.s;
}

module.exports = {
  signParentToken, readParentToken,
  TERMS, TERM_LABEL, round2, oid, escapeRe, slugify,
  getSettings, nextNumber, reserveNumbers, formatNumber,
  gradeFor, ordinal, emitSchool, todayStr,
  billStudents, billNewStudent, applyToBill, setBillDiscount,
};
