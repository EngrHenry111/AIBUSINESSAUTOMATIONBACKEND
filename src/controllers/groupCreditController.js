'use strict';

const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const GroupCreditCustomer = require('../models/GroupCreditCustomer');
const GroupCreditTxn = require('../models/GroupCreditTxn');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { agingFor, computeAging, sendCreditReminder } = require('../utils/groupCredit');
const { helpers } = require('./groupController');

const { isGroupLevel, visibleBranches } = helpers;
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The owner, and anyone who manages at least one branch, handle credit accounts.
async function canManageCredit(req) {
  if (isGroupLevel(req.user)) return true;
  return Boolean(await Branch.exists({ companyId: req.companyId, managerId: req.user._id }));
}

async function loadCustomer(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Customer not found.', 404);
  const c = await GroupCreditCustomer.findOne({ _id: id, companyId: req.companyId });
  if (!c) throw new AppError('Customer not found.', 404);
  return c;
}

const pickCustomer = (b) => {
  const out = {};
  ['name', 'contactName', 'phone', 'email', 'address'].forEach((k) => { if (b[k] !== undefined) out[k] = String(b[k] || '').trim(); });
  if (b.kind !== undefined) out.kind = ['company', 'fleet', 'government', 'individual'].includes(b.kind) ? b.kind : 'company';
  if (b.creditLimit !== undefined) out.creditLimit = Math.max(0, num(b.creditLimit));
  if (b.termsDays !== undefined) out.termsDays = Math.min(365, Math.max(0, Math.round(num(b.termsDays))));
  if (b.autoRemind !== undefined) out.autoRemind = Boolean(b.autoRemind);
  if (b.active !== undefined) out.active = Boolean(b.active);
  return out;
};

// GET /group/credit — every customer with balance and aging.
exports.list = async (req, res, next) => {
  try {
    const q = { companyId: req.companyId };
    if (req.query.active !== 'all') q.active = true;
    const customers = await GroupCreditCustomer.find(q).sort({ name: 1 }).lean();
    const aging = await agingFor(customers.map((c) => c._id));
    const data = customers.map((c) => {
      const a = aging[String(c._id)];
      return { ...c, ...a, overLimit: c.creditLimit > 0 && a.outstanding > c.creditLimit };
    });
    const totals = data.reduce((t, c) => {
      t.outstanding += c.outstanding;
      t.overdue += c.overdue;
      Object.keys(c.aging).forEach((k) => { t.aging[k] = (t.aging[k] || 0) + c.aging[k]; });
      return t;
    }, { outstanding: 0, overdue: 0, aging: {} });
    res.json({ success: true, data, totals, canManage: await canManageCredit(req) });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    if (!(await canManageCredit(req))) return next(new AppError('Only the owner or a branch manager can add credit customers.', 403));
    const data = pickCustomer(req.body);
    if (!data.name) return next(new AppError('Enter the customer name.', 400));
    const c = await GroupCreditCustomer.create({ ...data, companyId: req.companyId });
    const opening = num(req.body.openingBalance);
    if (opening) {
      const d = new Date();
      await GroupCreditTxn.create({ companyId: req.companyId, customerId: c._id, type: 'adjustment', amount: opening, date: d, dueDate: d, note: 'Opening balance', byName: req.user.name });
      c.balance = opening;
      await c.save();
    }
    res.status(201).json({ success: true, data: c });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    if (!(await canManageCredit(req))) return next(new AppError('Not allowed.', 403));
    const c = await loadCustomer(req, req.params.id);
    c.set(pickCustomer(req.body));
    await c.save();
    res.json({ success: true, data: c });
  } catch (err) { next(err); }
};

// GET /group/credit/:id — account with running balance (statement).
exports.get = async (req, res, next) => {
  try {
    const c = await loadCustomer(req, req.params.id);
    const txns = await GroupCreditTxn.find({ customerId: c._id }).sort({ date: 1, createdAt: 1 }).lean();
    let running = 0;
    const statement = txns.map((t) => { running = round2(running + t.amount); return { ...t, balance: running }; });
    res.json({ success: true, data: { customer: c, statement: statement.reverse(), ...computeAging(txns) }, canManage: await canManageCredit(req) });
  } catch (err) { next(err); }
};

// POST /group/credit/:id/payment  { amount, method, date, reference, branchId, note }
exports.payment = async (req, res, next) => {
  try {
    if (!(await canManageCredit(req))) return next(new AppError('Not allowed.', 403));
    const c = await loadCustomer(req, req.params.id);
    const amount = num(req.body.amount);
    if (amount <= 0) return next(new AppError('Enter the amount paid.', 400));
    let branch = null;
    if (req.body.branchId) branch = (await visibleBranches(req)).find((b) => String(b._id) === String(req.body.branchId)) || null;
    const date = req.body.date ? new Date(`${String(req.body.date).slice(0, 10)}T00:00:00.000Z`) : new Date();
    const t = await GroupCreditTxn.create({
      companyId: req.companyId, customerId: c._id, branchId: branch?._id || null, branchName: branch?.name,
      type: 'payment', amount: -amount, date, method: String(req.body.method || '').slice(0, 30),
      reference: String(req.body.reference || '').trim().slice(0, 80), note: String(req.body.note || '').trim().slice(0, 500), byName: req.user.name,
    });
    await GroupCreditCustomer.updateOne({ _id: c._id }, { $inc: { balance: -amount } });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.credit_payment', description: `${c.name}: ₦${amount.toLocaleString()}`, ip: req.ip });
    res.status(201).json({ success: true, data: t });
  } catch (err) { next(err); }
};

// POST /group/credit/:id/adjustment  { amount (signed), note }
exports.adjustment = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can adjust a credit balance.', 403));
    const c = await loadCustomer(req, req.params.id);
    const amount = num(req.body.amount);
    const note = String(req.body.note || '').trim();
    if (!amount) return next(new AppError('Enter the adjustment amount.', 400));
    if (!note) return next(new AppError('Give a reason for the adjustment.', 400));
    const d = new Date();
    await GroupCreditTxn.create({ companyId: req.companyId, customerId: c._id, type: 'adjustment', amount, date: d, dueDate: d, note, byName: req.user.name });
    await GroupCreditCustomer.updateOne({ _id: c._id }, { $inc: { balance: amount } });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.credit_adjustment', description: `${c.name}: ₦${amount.toLocaleString()} (${note})`, ip: req.ip });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// POST /group/credit/:id/remind
exports.remind = async (req, res, next) => {
  try {
    if (!(await canManageCredit(req))) return next(new AppError('Not allowed.', 403));
    const c = await loadCustomer(req, req.params.id);
    if (!c.phone && !c.email) return next(new AppError('Add a phone number or email for this customer first.', 400));
    const r = await sendCreditReminder(c);
    if (!r.results.length && !r.sent) return next(new AppError(r.reason || 'Nothing to remind about.', 400));
    res.json({ success: true, data: r });
  } catch (err) { next(err); }
};
