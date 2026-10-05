'use strict';

const mongoose = require('mongoose');
const FeeStructure = require('../models/FeeStructure');
const FeeBill = require('../models/FeeBill');
const FeePayment = require('../models/FeePayment');
const Student = require('../models/Student');
const SchoolClass = require('../models/SchoolClass');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const { paystackAPI } = require('../utils/paystack');
const logger = require('../utils/logger');
const {
  TERMS, TERM_LABEL, round2, oid, escapeRe, getSettings, nextNumber,
  emitSchool, billStudents, applyToBill, setBillDiscount, readParentToken,
} = require('../utils/school');
const { sendFeeReminders, collectTargets } = require('../utils/schoolFeeReminders');
const { findSchoolBySlug, _internal: { emailShell, sendGuardianEmail, escapeHtml } } = require('./schoolController');

const METHODS = ['cash', 'bank_transfer', 'pos', 'cheque', 'online'];
const io = (req) => req.app.get('io');
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

async function findOwned(Model, req, id, label) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${label} not found.`, 404);
  const doc = await Model.findOne({ _id: id, companyId: req.companyId });
  if (!doc) throw new AppError(`${label} not found.`, 404);
  return doc;
}

function cleanItems(items) {
  const out = (Array.isArray(items) ? items : [])
    .map((i) => ({ name: String(i?.name || '').trim().slice(0, 200), amount: round2(i?.amount) }))
    .filter((i) => i.name && i.amount >= 0);
  if (!out.length) throw new AppError('Add at least one fee item.', 400);
  return out;
}

function announcePayment(req, companyId, payment, student, bill, { online = false, transfer = false } = {}) {
  const name = student ? `${student.lastName} ${student.firstName}` : 'a student';
  emitSchool(req.app.get('io'), companyId, 'payment', {
    paymentId: payment._id, billId: bill?._id, studentId: payment.studentId, amount: payment.amount,
    message: `${naira(payment.amount)} ${transfer ? 'paid online by bank transfer' : online ? 'paid online' : 'received'} for ${name}`,
  });
  req.app.get('io')?.to(`company:${companyId}`).emit('notification:refresh', { type: 'school_payment' });
}

async function emailReceipt(companyId, payment, student, bill) {
  const to = payment.payerEmail || student?.guardian?.email;
  if (!to) return;
  const settings = await getSettings(companyId);
  sendGuardianEmail(to, `Payment receipt ${payment.receiptNumber}`, emailShell(settings, `
    <p>Payment received — thank you.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px 0;color:#64748b">Receipt</td><td style="text-align:right"><b>${payment.receiptNumber}</b></td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Student</td><td style="text-align:right">${escapeHtml(`${student.lastName} ${student.firstName}`)} (${escapeHtml(student.admissionNumber)})</td></tr>
      <tr><td style="padding:6px 0;color:#64748b">For</td><td style="text-align:right">${escapeHtml(bill.title || 'School fees')} · ${bill.session} ${TERM_LABEL[bill.term] || ''}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Amount paid</td><td style="text-align:right"><b>${naira(payment.amount)}</b></td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Balance on this bill</td><td style="text-align:right">${naira(Math.max(0, bill.balance))}</td></tr>
    </table>`));
}

// ── Fee structures ───────────────────────────────────────────────────────
exports.getStructures = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const filter = { companyId: req.companyId };
    filter.session = req.query.session || settings.currentSession;
    if (req.query.term !== 'all') filter.term = req.query.term || settings.currentTerm;
    const structures = await FeeStructure.find(filter).sort({ createdAt: -1 }).populate('classIds', 'name').lean();
    const stats = await FeeBill.aggregate([
      { $match: { companyId: oid(req.companyId), feeStructureId: { $in: structures.map((s) => s._id) }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$feeStructureId', bills: { $sum: 1 }, expected: { $sum: '$total' }, collected: { $sum: '$amountPaid' }, paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } } } },
    ]);
    const map = new Map(stats.map((s) => [String(s._id), s]));
    res.status(200).json({
      success: true,
      data: structures.map((s) => ({
        ...s,
        total: round2(s.items.reduce((sum, i) => sum + i.amount, 0)),
        stats: map.get(String(s._id)) || { bills: 0, expected: 0, collected: 0, paid: 0 },
      })),
    });
  } catch (err) { next(err); }
};

async function structureBody(req) {
  const body = pick(req.body, ['name', 'session', 'term', 'classIds', 'items', 'dueDate', 'autoApplyToNewStudents', 'active']);
  if (body.items !== undefined) body.items = cleanItems(body.items);
  if (body.term !== undefined && !TERMS.includes(body.term)) throw new AppError('Invalid term.', 400);
  if (body.classIds !== undefined) {
    const ids = (Array.isArray(body.classIds) ? body.classIds : []).filter((id) => mongoose.isValidObjectId(id));
    body.classIds = (await SchoolClass.find({ _id: { $in: ids }, companyId: req.companyId }).select('_id').lean()).map((c) => c._id);
  }
  if (body.dueDate === '') body.dueDate = null;
  return body;
}

exports.createStructure = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const body = await structureBody(req);
    if (!body.name) return next(new AppError('Give the fee structure a name.', 400));
    if (!body.items) return next(new AppError('Add at least one fee item.', 400));
    const structure = await FeeStructure.create({
      session: settings.currentSession, term: settings.currentTerm,
      ...body, companyId: req.companyId, createdBy: req.user._id,
    });
    let billed = 0;
    if (req.body.generateNow) billed = await generateFor(structure, req.user._id);
    emitSchool(io(req), req.companyId, 'fees');
    res.status(201).json({ success: true, data: structure, billed });
  } catch (err) { next(err); }
};

// Item changes apply to bills generated afterwards; existing bills keep what
// was billed (a parent may already have paid against them).
exports.updateStructure = async (req, res, next) => {
  try {
    const structure = await findOwned(FeeStructure, req, req.params.id, 'Fee structure');
    Object.assign(structure, await structureBody(req));
    await structure.save();
    emitSchool(io(req), req.companyId, 'fees');
    res.status(200).json({ success: true, data: structure });
  } catch (err) { next(err); }
};

exports.deleteStructure = async (req, res, next) => {
  try {
    const structure = await findOwned(FeeStructure, req, req.params.id, 'Fee structure');
    const billIds = await FeeBill.find({ feeStructureId: structure._id }).distinct('_id');
    if (billIds.length && await FeePayment.exists({ billId: { $in: billIds } })) {
      return next(new AppError('Payments have been made against these bills. Deactivate the structure instead.', 400));
    }
    await FeeBill.deleteMany({ feeStructureId: structure._id, companyId: req.companyId });
    await structure.deleteOne();
    emitSchool(io(req), req.companyId, 'fees');
    res.status(200).json({ success: true, message: 'Fee structure and its unpaid bills deleted.' });
  } catch (err) { next(err); }
};

async function generateFor(structure, userId) {
  const filter = { companyId: structure.companyId, status: 'active', classId: { $ne: null } };
  if (structure.classIds?.length) filter.classId = { $in: structure.classIds };
  const students = await Student.find(filter).select('_id classId').lean();
  return billStudents(structure, students, userId);
}

exports.generateBills = async (req, res, next) => {
  try {
    const structure = await findOwned(FeeStructure, req, req.params.id, 'Fee structure');
    if (!structure.active) return next(new AppError('Activate this fee structure first.', 400));
    const billed = await generateFor(structure, req.user._id);
    if (billed) require('../utils/bankTransfers').applyStudentCredits(req.companyId, null, io(req)).catch(() => {});
    emitSchool(io(req), req.companyId, 'fees');
    res.status(200).json({ success: true, data: { billed }, message: billed ? `${billed} bill(s) created.` : 'Every student already has this bill.' });
  } catch (err) { next(err); }
};

// ── Bills ────────────────────────────────────────────────────────────────
async function studentIdsMatching(companyId, search) {
  const re = new RegExp(escapeRe(String(search).trim()), 'i');
  return Student.find({ companyId, $or: [{ firstName: re }, { lastName: re }, { admissionNumber: re }] }).limit(500).distinct('_id');
}

exports.getBills = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { companyId: req.companyId };
    if (req.query.session !== 'all') filter.session = req.query.session || settings.currentSession;
    if (req.query.term !== 'all') filter.term = req.query.term || settings.currentTerm;
    if (req.query.status === 'outstanding') filter.status = { $in: ['unpaid', 'partial'] };
    else if (req.query.status) filter.status = req.query.status;
    if (mongoose.isValidObjectId(req.query.classId)) filter.classId = req.query.classId;
    if (mongoose.isValidObjectId(req.query.studentId)) filter.studentId = req.query.studentId;
    if (mongoose.isValidObjectId(req.query.feeStructureId)) filter.feeStructureId = req.query.feeStructureId;
    if (req.query.search) {
      const ids = await studentIdsMatching(req.companyId, req.query.search);
      filter.$or = [{ studentId: { $in: ids } }, { billNumber: new RegExp(escapeRe(String(req.query.search).trim()), 'i') }];
    }
    const [bills, total, totals] = await Promise.all([
      FeeBill.find(filter).sort({ balance: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('studentId', 'firstName lastName admissionNumber guardian.phone').populate('classId', 'name').lean(),
      FeeBill.countDocuments(filter),
      FeeBill.aggregate([
        { $match: { ...filter, companyId: oid(req.companyId), ...(filter.classId && { classId: oid(filter.classId) }), ...(filter.studentId && { studentId: oid(filter.studentId) }), ...(filter.feeStructureId && { feeStructureId: oid(filter.feeStructureId) }) } },
        { $match: { status: { $nin: ['waived', 'cancelled'] } } },
        { $group: { _id: null, expected: { $sum: '$total' }, collected: { $sum: '$amountPaid' }, outstanding: { $sum: { $max: ['$balance', 0] } } } },
      ]),
    ]);
    res.status(200).json({
      success: true, data: bills,
      totals: totals[0] || { expected: 0, collected: 0, outstanding: 0 },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

// One-off bill for one student (e.g. a lost-book charge, an excursion).
exports.createBill = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const student = await findOwned(Student, req, req.body.studentId, 'Student');
    const items = cleanItems(req.body.items);
    const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
    const term = TERMS.includes(req.body.term) ? req.body.term : settings.currentTerm;
    const bill = await FeeBill.create({
      companyId: req.companyId,
      billNumber: await nextNumber(req.companyId, 'bill'),
      studentId: student._id, classId: student.classId,
      title: String(req.body.title || 'Additional charges').slice(0, 200),
      session: req.body.session || settings.currentSession, term,
      items, subtotal, total: subtotal, balance: subtotal,
      status: subtotal > 0 ? 'unpaid' : 'paid',
      dueDate: req.body.dueDate || undefined,
      createdBy: req.user._id,
    });
    require('../utils/bankTransfers').applyStudentCredits(req.companyId, [student._id], io(req)).catch(() => {});
    emitSchool(io(req), req.companyId, 'fees', { studentId: student._id });
    res.status(201).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

exports.updateBill = async (req, res, next) => {
  try {
    let bill = await findOwned(FeeBill, req, req.params.id, 'Bill');
    if (req.body.discount !== undefined) {
      const updated = await setBillDiscount(req.companyId, bill._id, req.body.discount, String(req.body.discountReason || '').slice(0, 300));
      if (!updated) return next(new AppError('Discount can\'t be more than the bill, or the bill is waived/cancelled.', 400));
      bill = updated;
    }
    const meta = pick(req.body, ['title', 'dueDate']);
    if (Object.keys(meta).length) {
      bill = await FeeBill.findOneAndUpdate({ _id: bill._id, companyId: req.companyId }, { $set: meta }, { new: true });
    }
    emitSchool(io(req), req.companyId, 'fees', { billId: bill._id, studentId: bill.studentId });
    res.status(200).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

exports.waiveBill = async (req, res, next) => {
  try {
    const bill = await FeeBill.findOneAndUpdate(
      { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null, companyId: req.companyId, status: { $in: ['unpaid', 'partial'] } },
      { $set: { status: 'waived', discountReason: String(req.body.reason || 'Waived').slice(0, 300) } },
      { new: true },
    );
    if (!bill) return next(new AppError('Only an unpaid or part-paid bill can be waived.', 400));
    emitSchool(io(req), req.companyId, 'fees', { billId: bill._id, studentId: bill.studentId });
    res.status(200).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

exports.cancelBill = async (req, res, next) => {
  try {
    const bill = await FeeBill.findOneAndUpdate(
      { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null, companyId: req.companyId, amountPaid: { $lte: 0 }, status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled' } },
      { new: true },
    );
    if (!bill) return next(new AppError('Only a bill with no payments can be cancelled. Void its payments first.', 400));
    emitSchool(io(req), req.companyId, 'fees', { billId: bill._id, studentId: bill.studentId });
    res.status(200).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

// Rebuilds amountPaid/balance from the bill's receipts — a repair tool.
exports.recalculateBill = async (req, res, next) => {
  try {
    const bill = await findOwned(FeeBill, req, req.params.id, 'Bill');
    const [sum] = await FeePayment.aggregate([
      { $match: { companyId: oid(req.companyId), billId: bill._id, voided: false } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]);
    const paid = round2(sum?.amount || 0);
    bill.amountPaid = paid;
    bill.balance = round2(bill.total - paid);
    if (!['waived', 'cancelled'].includes(bill.status)) bill.status = bill.balance <= 0 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
    await bill.save();
    emitSchool(io(req), req.companyId, 'fees', { billId: bill._id, studentId: bill.studentId });
    res.status(200).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

// GET /school/fees/debtors — who owes, biggest balance first.
exports.getDebtors = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const match = { companyId: oid(req.companyId), status: { $in: ['unpaid', 'partial'] }, balance: { $gt: 0 } };
    if (req.query.session !== 'all') match.session = req.query.session || settings.currentSession;
    if (req.query.term !== 'all') match.term = req.query.term || settings.currentTerm;
    if (mongoose.isValidObjectId(req.query.classId)) match.classId = oid(req.query.classId);
    const rows = await FeeBill.aggregate([
      { $match: match },
      { $group: { _id: '$studentId', balance: { $sum: '$balance' }, total: { $sum: '$total' }, paid: { $sum: '$amountPaid' }, bills: { $sum: 1 }, oldestDue: { $min: '$dueDate' }, lastReminded: { $max: '$lastReminderAt' } } },
      { $sort: { balance: -1 } },
      { $limit: 2000 },
      { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 'student' } },
      { $unwind: '$student' },
      { $lookup: { from: 'schoolclasses', localField: 'student.classId', foreignField: '_id', as: 'class' } },
      { $project: {
        balance: 1, total: 1, paid: 1, bills: 1, oldestDue: 1, lastReminded: 1,
        student: { _id: '$student._id', firstName: '$student.firstName', lastName: '$student.lastName', admissionNumber: '$student.admissionNumber', status: '$student.status', guardian: '$student.guardian' },
        className: { $first: '$class.name' },
      } },
    ]);
    res.status(200).json({ success: true, data: rows, totalOutstanding: round2(rows.reduce((s, r) => s + r.balance, 0)) });
  } catch (err) { next(err); }
};

// GET /school/fees/summary — expected vs collected per class.
exports.getFeeSummary = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const session = req.query.session || settings.currentSession;
    const term = req.query.term || settings.currentTerm;
    const [byClass, byMethod] = await Promise.all([
      FeeBill.aggregate([
        { $match: { companyId: oid(req.companyId), session, term, status: { $nin: ['waived', 'cancelled'] } } },
        { $group: { _id: '$classId', expected: { $sum: '$total' }, collected: { $sum: '$amountPaid' }, outstanding: { $sum: { $max: ['$balance', 0] } }, students: { $addToSet: '$studentId' }, paidBills: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } }, bills: { $sum: 1 } } },
        { $lookup: { from: 'schoolclasses', localField: '_id', foreignField: '_id', as: 'class' } },
        { $project: { expected: 1, collected: 1, outstanding: 1, bills: 1, paidBills: 1, students: { $size: '$students' }, name: { $first: '$class.name' }, level: { $first: '$class.level' } } },
        { $sort: { level: 1, name: 1 } },
      ]),
      FeePayment.aggregate([
        { $match: { companyId: oid(req.companyId), voided: false } },
        { $lookup: { from: 'feebills', localField: 'billId', foreignField: '_id', as: 'bill' } },
        { $match: { 'bill.session': session, 'bill.term': term } },
        { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);
    res.status(200).json({ success: true, data: { session, term, byClass, byMethod } });
  } catch (err) { next(err); }
};

// ── Payments ─────────────────────────────────────────────────────────────
exports.getPayments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { companyId: req.companyId };
    if (req.query.includeVoided !== 'true') filter.voided = false;
    if (METHODS.includes(req.query.method)) filter.method = req.query.method;
    if (mongoose.isValidObjectId(req.query.studentId)) filter.studentId = req.query.studentId;
    if (req.query.from || req.query.to) {
      filter.paidAt = {};
      if (req.query.from) filter.paidAt.$gte = new Date(`${req.query.from}T00:00:00`);
      if (req.query.to) filter.paidAt.$lte = new Date(`${req.query.to}T23:59:59.999`);
    }
    if (req.query.search) {
      const ids = await studentIdsMatching(req.companyId, req.query.search);
      filter.$or = [{ studentId: { $in: ids } }, { receiptNumber: new RegExp(escapeRe(String(req.query.search).trim()), 'i') }, { reference: new RegExp(escapeRe(String(req.query.search).trim()), 'i') }];
    }
    const sumFilter = { ...filter, companyId: oid(req.companyId), voided: false };
    if (sumFilter.studentId) sumFilter.studentId = oid(sumFilter.studentId);
    const [payments, total, sum] = await Promise.all([
      FeePayment.find(filter).sort({ paidAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('studentId', 'firstName lastName admissionNumber').populate('billId', 'billNumber title session term').populate('recordedBy', 'name').lean(),
      FeePayment.countDocuments(filter),
      FeePayment.aggregate([{ $match: sumFilter }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    ]);
    res.status(200).json({ success: true, data: payments, totals: sum[0] || { amount: 0, count: 0 }, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

// POST /school/fees/payments — a payment taken at the bursary.
exports.recordPayment = async (req, res, next) => {
  try {
    const bill = await findOwned(FeeBill, req, req.body.billId, 'Bill');
    const amount = round2(req.body.amount);
    if (!(amount > 0)) return next(new AppError('Enter the amount paid.', 400));
    const method = METHODS.includes(req.body.method) ? req.body.method : 'cash';

    // Reserve the money on the bill first (guarded — never more than owed)…
    const updated = await applyToBill(req.companyId, bill._id, amount, { guard: true });
    if (!updated) {
      const fresh = await FeeBill.findById(bill._id).select('balance status').lean();
      if (!['unpaid', 'partial'].includes(fresh?.status)) return next(new AppError(`This bill is ${fresh?.status}; it can't take payments.`, 400));
      return next(new AppError(`Amount is more than the balance owed (${naira(fresh?.balance)}).`, 400));
    }
    // …then write the receipt. If that fails, give the money back to the bill.
    let payment;
    try {
      payment = await FeePayment.create({
        companyId: req.companyId,
        receiptNumber: await nextNumber(req.companyId, 'receipt'),
        billId: bill._id, studentId: bill.studentId, amount, method,
        reference: String(req.body.reference || '').slice(0, 120),
        payerName: String(req.body.payerName || '').slice(0, 200),
        note: String(req.body.note || '').slice(0, 500),
        paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date(),
        recordedBy: req.user._id,
      });
    } catch (e) {
      await applyToBill(req.companyId, bill._id, -amount);
      throw e;
    }
    const student = await Student.findById(bill.studentId).lean();
    announcePayment(req, req.companyId, payment, student, updated);
    if (req.body.sendReceipt !== false) emailReceipt(req.companyId, payment, student, updated).catch(() => {});
    res.status(201).json({ success: true, data: { payment, bill: updated } });
  } catch (err) { next(err); }
};

exports.getPayment = async (req, res, next) => {
  try {
    const payment = await findOwned(FeePayment, req, req.params.id, 'Payment');
    await payment.populate([
      { path: 'studentId', select: 'firstName lastName otherNames admissionNumber classId guardian', populate: { path: 'classId', select: 'name' } },
      { path: 'billId' },
      { path: 'recordedBy', select: 'name' },
    ]);
    const settings = await getSettings(req.companyId);
    res.status(200).json({ success: true, data: { payment, school: pick(settings.toObject(), ['schoolName', 'motto', 'address', 'phone', 'email', 'logo']) } });
  } catch (err) { next(err); }
};

exports.voidPayment = async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return next(new AppError('Give a reason for voiding this payment.', 400));
    const payment = await FeePayment.findOneAndUpdate(
      { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null, companyId: req.companyId, voided: false },
      { $set: { voided: true, voidedAt: new Date(), voidedBy: req.user._id, voidReason: reason.slice(0, 500) } },
      { new: true },
    );
    if (!payment) return next(new AppError('Payment not found or already voided.', 404));
    const bill = await applyToBill(req.companyId, payment.billId, -payment.amount);
    // Money that came in by transfer goes back to that transfer's credit,
    // ready to apply to the right bill.
    if (payment.transferId) {
      const BankTransfer = require('../models/BankTransfer');
      const t = await BankTransfer.findOneAndUpdate({ _id: payment.transferId }, { $inc: { creditRemaining: payment.amount } }, { new: true });
      if (t) { t.status = t.creditRemaining >= t.amount - 0.001 ? 'credit' : 'partially_applied'; await t.save(); }
    }
    emitSchool(io(req), req.companyId, 'payment', { paymentId: payment._id, billId: payment.billId, studentId: payment.studentId, voided: true });
    res.status(200).json({ success: true, data: { payment, bill } });
  } catch (err) { next(err); }
};

// ── Public: parents pay fees online ──────────────────────────────────────
const digits = (s) => String(s || '').replace(/\D/g, '');

// A parent proves who they are with the admission number plus the phone
// number or email the school has on file for the guardian.
async function findStudentForParent(companyId, admissionNumber, contact) {
  const adm = String(admissionNumber || '').trim();
  const c = String(contact || '').trim().toLowerCase();
  if (!adm || !c) throw new AppError('Enter the admission number and the parent\'s phone number or email.', 400);
  const student = await Student.findOne({ companyId, admissionNumber: new RegExp(`^${escapeRe(adm)}$`, 'i') }).populate('classId', 'name').lean();
  const phoneOk = (a, b) => a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10);
  const ok = student && (
    (student.guardian?.email && student.guardian.email === c)
    || phoneOk(digits(student.guardian?.phone), digits(c))
  );
  if (!ok) throw new AppError('We could not match those details. Check the admission number and the phone/email registered with the school.', 404);
  return student;
}

async function parentView(companyId, student) {
  const [bills, payments] = await Promise.all([
    FeeBill.find({ companyId, studentId: student._id, status: { $in: ['unpaid', 'partial'] } }).sort({ createdAt: 1 })
      .select('billNumber title session term items total amountPaid balance dueDate status discount').lean(),
    FeePayment.find({ companyId, studentId: student._id, voided: false }).sort({ paidAt: -1 }).limit(10)
      .select('receiptNumber amount method paidAt').lean(),
  ]);
  const bankAccount = await require('../models/VirtualAccount').findOne({ companyId, ownerType: 'student', ownerId: student._id }).select('accountNumber accountName bankName -_id').lean();
  return {
    student: { name: [student.lastName, student.firstName, student.otherNames].filter(Boolean).join(' '), admissionNumber: student.admissionNumber, className: student.classId?.name || null },
    bankAccount,
    bills, payments,
    outstanding: round2(bills.reduce((s, b) => s + Math.max(0, b.balance), 0)),
  };
}

exports.publicLookup = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const student = await findStudentForParent(settings.companyId, req.body.admissionNumber, req.body.contact);
    res.status(200).json({ success: true, data: await parentView(settings.companyId, student) });
  } catch (err) { next(err); }
};

exports.publicInitializePayment = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const company = await Company.findById(settings.companyId).select('paymentSettings status').lean();
    if (!settings.onlinePaymentsEnabled || !company?.paymentSettings?.isPaymentSetup || !company.paymentSettings.paystackSubaccountCode) {
      return next(new AppError('Online payment is not available for this school yet. Please pay at the school.', 400));
    }
    // Signed-in parent portal (token) or the one-off admission number + contact form.
    let student;
    if (req.headers['x-parent-token']) {
      const allowed = readParentToken(req, settings.companyId);
      if (!allowed.includes(String(req.body.studentId))) return next(new AppError('Student not found.', 404));
      student = await Student.findOne({ _id: req.body.studentId, companyId: settings.companyId }).lean();
      if (!student) return next(new AppError('Student not found.', 404));
    } else {
      student = await findStudentForParent(settings.companyId, req.body.admissionNumber, req.body.contact);
    }
    if (!mongoose.isValidObjectId(req.body.billId)) return next(new AppError('Choose a bill to pay.', 400));
    const bill = await FeeBill.findOne({ _id: req.body.billId, companyId: settings.companyId, studentId: student._id, status: { $in: ['unpaid', 'partial'] } }).lean();
    if (!bill || bill.balance <= 0) return next(new AppError('This bill has nothing left to pay.', 400));

    const amount = round2(req.body.amount || bill.balance);
    const min = Math.min(bill.balance, settings.minimumOnlinePayment || 0);
    if (amount > bill.balance) return next(new AppError(`The most you can pay on this bill is ${naira(bill.balance)}.`, 400));
    if (amount < min) return next(new AppError(`The minimum online payment is ${naira(min)}.`, 400));

    const email = String(req.body.email || student.guardian?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return next(new AppError('Enter an email address for your receipt.', 400));

    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email,
      amount: Math.round(amount * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: {
        type: 'school_fee',
        companyId: String(settings.companyId),
        slug: settings.slug,
        billId: String(bill._id),
        studentId: String(student._id),
        amount,
        payerEmail: email,
        payerName: String(req.body.payerName || student.guardian?.name || '').slice(0, 200),
        cancel_action: `${clientUrl()}/schools/${settings.slug}/portal?payment=cancelled`,
      },
      callback_url: `${clientUrl()}/schools/${settings.slug}/portal`,
    });
    if (!initRes.status) throw new AppError('Could not start the payment. Please try again.', 502);
    res.status(200).json({ success: true, data: { authorizationUrl: initRes.data.authorization_url, reference: initRes.data.reference } });
  } catch (err) { next(err); }
};

/**
 * Credits a successful Paystack fee payment. Called by both the parent's
 * verify request and the webhook — whichever arrives first wins; the unique
 * paystackReference index makes the second a no-op.
 */
async function fulfilSchoolFeePayment(txn, { io: socketIo } = {}) {
  const meta = txn.metadata || {};
  const reference = txn.reference;
  const existing = await FeePayment.findOne({ paystackReference: reference });
  if (existing) return { payment: existing, duplicate: true };

  const expectedKobo = Math.round(Number(meta.amount) * 100);
  const problems = [];
  if (meta.type !== 'school_fee') problems.push(`type=${meta.type}`);
  if (txn.status !== 'success') problems.push(`status=${txn.status}`);
  if (txn.currency && txn.currency !== 'NGN') problems.push(`currency=${txn.currency}`);
  if (!(expectedKobo > 0) || !(Number(txn.amount) >= expectedKobo)) problems.push(`amount=${txn.amount} expected>=${expectedKobo}`);
  if (!mongoose.isValidObjectId(meta.billId) || !mongoose.isValidObjectId(meta.companyId)) problems.push('bad metadata');
  if (problems.length) {
    logger.error(`Refusing school fee credit for ${reference}: ${problems.join(', ')}`);
    throw new AppError('Payment could not be confirmed with Paystack.', 400);
  }

  const bill = await FeeBill.findOne({ _id: meta.billId, companyId: meta.companyId }).lean();
  if (!bill) throw new AppError('Bill not found for this payment.', 404);
  const amount = round2(Number(txn.amount) / 100);

  let payment;
  try {
    payment = await FeePayment.create({
      companyId: bill.companyId,
      receiptNumber: await nextNumber(bill.companyId, 'receipt'),
      billId: bill._id, studentId: bill.studentId, amount, method: 'online',
      reference, paystackReference: reference,
      payerName: meta.payerName, payerEmail: meta.payerEmail || txn.customer?.email,
      note: `Paid online via Paystack (${txn.channel || 'online'})`,
      paidAt: txn.paid_at ? new Date(txn.paid_at) : new Date(),
    });
  } catch (err) {
    if (err.code === 11000) return { payment: await FeePayment.findOne({ paystackReference: reference }), duplicate: true };
    throw err;
  }
  // Money has been collected — always credit it, even past the balance
  // (a negative balance shows as credit on the student's account).
  const updated = await applyToBill(bill.companyId, bill._id, amount);
  const student = await Student.findById(bill.studentId).lean();
  announcePayment({ app: { get: () => socketIo } }, bill.companyId, payment, student, updated, { online: true });
  emailReceipt(bill.companyId, payment, student, updated).catch(() => {});
  return { payment, bill: updated };
}
exports.fulfilSchoolFeePayment = fulfilSchoolFeePayment;

exports.publicVerifyPayment = async (req, res, next) => {
  try {
    const settings = await findSchoolBySlug(req.params.slug);
    const { reference } = req.params;
    let payment = await FeePayment.findOne({ paystackReference: reference, companyId: settings.companyId }).lean();
    if (!payment) {
      const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      const txn = vr.data || {};
      if (String(txn.metadata?.companyId) !== String(settings.companyId)) return next(new AppError('Payment not found for this school.', 404));
      if (['pending', 'ongoing', 'processing', 'queued'].includes(txn.status)) {
        return res.status(202).json({ success: true, data: { state: 'pending' } });
      }
      if (txn.status !== 'success') return res.status(200).json({ success: true, data: { state: 'failed', message: txn.gateway_response || 'The payment was not completed.' } });
      ({ payment } = await fulfilSchoolFeePayment(txn, { io: io(req) }));
    }
    const [bill, student] = await Promise.all([
      FeeBill.findById(payment.billId).select('billNumber title session term total amountPaid balance').lean(),
      Student.findById(payment.studentId).select('firstName lastName admissionNumber').lean(),
    ]);
    res.status(200).json({
      success: true,
      data: {
        state: 'ok',
        receipt: {
          receiptNumber: payment.receiptNumber, amount: payment.amount, paidAt: payment.paidAt,
          student: `${student.lastName} ${student.firstName}`, admissionNumber: student.admissionNumber,
          bill,
        },
      },
    });
  } catch (err) { next(err); }
};

exports.findStudentForParent = findStudentForParent;
exports.parentView = parentView;

// POST /school/fees/reminders { classId?, studentIds?, channels?, dryRun? }
// Replies at once; messages go out in the background and the result
// arrives on the socket as a 'reminders' school:update.
exports.sendReminders = async (req, res, next) => {
  try {
    const opts = {
      classId: mongoose.isValidObjectId(req.body.classId) ? req.body.classId : undefined,
      studentIds: Array.isArray(req.body.studentIds) ? req.body.studentIds.filter((id) => mongoose.isValidObjectId(id)) : undefined,
      channels: req.body.channels && typeof req.body.channels === 'object'
        ? { email: Boolean(req.body.channels.email), sms: Boolean(req.body.channels.sms), whatsapp: Boolean(req.body.channels.whatsapp) }
        : undefined,
    };
    const { targets, skippedRecent } = await collectTargets(req.companyId, opts);
    const withContact = targets.filter((t) => t.student.guardian?.email || t.student.guardian?.phone).length;
    if (req.body.dryRun) {
      let whatsappConnected = false;
      try { whatsappConnected = require('../services/whatsappService').getStatus(req.companyId)?.status === 'connected'; } catch { /* optional */ }
      return res.status(200).json({ success: true, data: { students: targets.length, withContact, skippedRecent, whatsappConnected } });
    }
    if (opts.channels && !opts.channels.email && !opts.channels.sms && !opts.channels.whatsapp) {
      return next(new AppError('Choose at least one way to send the reminder.', 400));
    }
    const socketIo = io(req);
    sendFeeReminders(req.companyId, opts)
      .then((result) => emitSchool(socketIo, req.companyId, 'reminders', { result }))
      .catch((e) => logger.error(`Fee reminders failed: ${e.message}`));
    res.status(202).json({ success: true, data: { queued: withContact, skippedRecent } });
  } catch (err) { next(err); }
};

exports._internal = { announcePayment, emailReceipt };
