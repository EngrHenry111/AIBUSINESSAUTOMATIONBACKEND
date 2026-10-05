'use strict';

// Students' dedicated bank accounts and the transfers received into them.

const mongoose = require('mongoose');
const VirtualAccount = require('../models/VirtualAccount');
const BankTransfer = require('../models/BankTransfer');
const Student = require('../models/Student');
const { AppError } = require('../middleware/errorMiddleware');
const { oid, escapeRe, getSettings } = require('../utils/school');
const {
  createStudentAccount, createAccountsForStudents, applyTransferCredit,
} = require('../utils/bankTransfers');

const io = (req) => req.app.get('io');

function assertEnabled(settings) {
  if (!settings.bankAccounts?.enabled) {
    throw new AppError('Turn on "Bank transfer accounts" in School settings first.', 400);
  }
}

// POST /school/students/:id/bank-account
exports.createForStudent = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Student not found.', 404));
    assertEnabled(await getSettings(req.companyId));
    const account = await createStudentAccount(req.companyId, req.params.id);
    res.status(201).json({ success: true, data: account });
  } catch (err) { next(err); }
};

// POST /school/bank-accounts/bulk { classId? } — every active student
// (in the class) without an account. Runs in the background; progress
// arrives as 'bank-accounts' socket events.
exports.createBulk = async (req, res, next) => {
  try {
    assertEnabled(await getSettings(req.companyId));
    const filter = { companyId: req.companyId, status: 'active' };
    if (mongoose.isValidObjectId(req.body.classId)) filter.classId = req.body.classId;
    const [students, have] = await Promise.all([
      Student.find(filter).select('_id').lean(),
      VirtualAccount.find({ companyId: req.companyId, ownerType: 'student' }).distinct('ownerId'),
    ]);
    const haveSet = new Set(have.map(String));
    const todo = students.map((s) => s._id).filter((id) => !haveSet.has(String(id)));
    if (todo.length) createAccountsForStudents(req.companyId, todo, io(req)).catch(() => {});
    res.status(202).json({ success: true, data: { queued: todo.length, alreadyHave: students.length - todo.length } });
  } catch (err) { next(err); }
};

// GET /school/bank-accounts/summary — how many students have accounts.
exports.summary = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const [active, withAccount, creditAgg] = await Promise.all([
      Student.countDocuments({ companyId: req.companyId, status: 'active' }),
      VirtualAccount.countDocuments({ companyId: req.companyId, ownerType: 'student' }),
      BankTransfer.aggregate([{ $match: { companyId: oid(req.companyId), creditRemaining: { $gt: 0.001 } } }, { $group: { _id: null, credit: { $sum: '$creditRemaining' }, count: { $sum: 1 } } }]),
    ]);
    res.status(200).json({
      success: true,
      data: { enabled: Boolean(settings.bankAccounts?.enabled), activeStudents: active, withAccount, unappliedCredit: creditAgg[0]?.credit || 0, transfersWithCredit: creditAgg[0]?.count || 0 },
    });
  } catch (err) { next(err); }
};

// GET /school/transfers?status&search&page
exports.getTransfers = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { companyId: req.companyId };
    if (req.query.status === 'credit') filter.creditRemaining = { $gt: 0.001 };
    else if (['applied', 'partially_applied', 'processing'].includes(req.query.status)) filter.status = req.query.status;
    if (mongoose.isValidObjectId(req.query.studentId)) filter.ownerId = req.query.studentId;
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      const ids = await Student.find({ companyId: req.companyId, $or: [{ firstName: re }, { lastName: re }, { admissionNumber: re }] }).limit(500).distinct('_id');
      filter.$or = [{ ownerId: { $in: ids } }, { senderName: re }, { reference: re }, { accountNumber: re }];
    }
    const [rows, total, sums] = await Promise.all([
      BankTransfer.find(filter).sort({ paidAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      BankTransfer.countDocuments(filter),
      BankTransfer.aggregate([{ $match: { ...filter, companyId: oid(req.companyId), ...(filter.ownerId && { ownerId: oid(filter.ownerId) }) } }, { $group: { _id: null, amount: { $sum: '$amount' }, credit: { $sum: '$creditRemaining' } } }]),
    ]);
    const students = await Student.find({ _id: { $in: rows.map((r) => r.ownerId) } }).select('firstName lastName admissionNumber').lean();
    const byId = new Map(students.map((s) => [String(s._id), s]));
    res.status(200).json({
      success: true,
      data: rows.map((r) => ({ ...r, student: byId.get(String(r.ownerId)) || null })),
      totals: sums[0] || { amount: 0, credit: 0 },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

// POST /school/transfers/:id/apply — spend held credit on outstanding bills.
exports.applyCredit = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Transfer not found.', 404));
    const t = await BankTransfer.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!t) return next(new AppError('Transfer not found.', 404));
    if (t.creditRemaining <= 0.001) return next(new AppError('Nothing left to apply on this transfer.', 400));
    const { transfer, payments } = await applyTransferCredit(t._id, { by: 'staff', io: io(req) });
    if (!payments.length) return next(new AppError('This student has no outstanding bills to apply the credit to.', 400));
    res.status(200).json({ success: true, data: { transfer, applied: payments.length } });
  } catch (err) { next(err); }
};
