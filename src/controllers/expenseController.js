'use strict';

const fs = require('fs');
const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const { cloudinary } = require('../config/cloudinary');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CANCELLED_ORDER = ['cancelled', 'refunded'];

// ── helpers ───────────────────────────────────────────────────────────
async function uploadReceiptFile(localPath, companyId) {
  if (!cloudinary) {
    return `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${localPath.split(/[\\/]/).pop()}`;
  }
  const r = await cloudinary.uploader.upload(localPath, {
    folder: `business-ai/${companyId}/receipts`,
    resource_type: 'auto',
  });
  fs.unlink(localPath, () => {});
  return r.secure_url;
}

async function revenueBetween(companyId, start, end) {
  const [invAgg, ordAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: { companyId, status: 'paid', paidAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    Order.aggregate([
      { $match: { companyId, status: { $nin: CANCELLED_ORDER }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
  ]);
  const invoices = invAgg[0]?.total || 0;
  const orders = ordAgg[0]?.total || 0;
  return { invoices, orders, total: invoices + orders };
}

async function expensesBetween(companyId, start, end) {
  const agg = await Expense.aggregate([
    { $match: { companyId, status: { $ne: 'rejected' }, date: { $gte: start, $lte: end } } },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  const total = agg.reduce((s, c) => s + c.total, 0);
  const byCategory = agg.map((c) => ({
    category: c._id, total: c.total, count: c.count,
    percentage: total ? Math.round((c.total / total) * 1000) / 10 : 0,
  }));
  return { total, byCategory };
}

const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
const pctChange = (curr, prev) => (prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : (curr > 0 ? 100 : 0));

// ── GET /expenses ─────────────────────────────────────────────────────
exports.getExpenses = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 30);
    const { category, paymentMethod, createdBy, search, from, to, sort = 'date', order = 'desc' } = req.query;

    const q = { companyId: req.companyId };
    if (category) q.category = category;
    if (paymentMethod) q.paymentMethod = paymentMethod;
    if (createdBy) q.createdBy = createdBy;
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }
    if (search && search.trim()) {
      const rx = { $regex: esc(search.trim()), $options: 'i' };
      q.$or = [{ title: rx }, { vendor: rx }, { description: rx }];
    }

    const sortField = ['date', 'amount', 'category', 'createdAt'].includes(sort) ? sort : 'date';
    const sortSpec = { [sortField]: order === 'asc' ? 1 : -1 };

    const [expenses, count, totalsAgg, byCatAgg] = await Promise.all([
      Expense.find(q).populate('createdBy', 'name').sort(sortSpec).skip((page - 1) * limit).limit(limit).lean(),
      Expense.countDocuments(q),
      Expense.aggregate([{ $match: q }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.aggregate([
        { $match: q },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: expenses,
      pagination: { total: count, page, limit, pages: Math.ceil(count / limit) || 1 },
      totals: {
        total: totalsAgg[0]?.total || 0,
        count,
        byCategory: byCatAgg.map((c) => ({ category: c._id, total: c.total, count: c.count })),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /expenses/summary ─────────────────────────────────────────────
exports.getExpenseSummary = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = req.query.month != null ? Number(req.query.month) : now.getMonth();
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

    const [{ total: totalExpenses, byCategory }, revenue, topExpenses, recurringAgg] = await Promise.all([
      expensesBetween(companyId, start, end),
      revenueBetween(companyId, start, end),
      Expense.find({ companyId, status: { $ne: 'rejected' }, date: { $gte: start, $lte: end } })
        .sort({ amount: -1 }).limit(5).select('title amount category date vendor').lean(),
      Expense.aggregate([
        { $match: { companyId, isRecurring: true, status: { $ne: 'rejected' } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    // last 6 months of expense totals
    const sixStart = new Date(year, month - 5, 1);
    const monthsAgg = await Expense.aggregate([
      { $match: { companyId, status: { $ne: 'rejected' }, date: { $gte: sixStart, $lte: end } } },
      { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' } }, total: { $sum: '$amount' } } },
    ]);
    const byMonth = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, month - i, 1);
      const hit = monthsAgg.find((x) => x._id.y === d.getFullYear() && x._id.m === d.getMonth() + 1);
      byMonth.push({ month: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }), total: hit?.total || 0 });
    }

    const grossProfit = revenue.total - totalExpenses;
    res.status(200).json({
      success: true,
      data: {
        period: { start, end },
        totalExpenses,
        totalRevenue: revenue.total,
        grossProfit,
        profitMargin: revenue.total ? Math.round((grossProfit / revenue.total) * 1000) / 10 : 0,
        byCategory,
        byMonth,
        topExpenses,
        recurringTotal: recurringAgg[0]?.total || 0,
        expenseCount: (await Expense.countDocuments({ companyId, status: { $ne: 'rejected' }, date: { $gte: start, $lte: end } })),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /expenses/profit-loss ─────────────────────────────────────────
exports.getProfitLoss = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const now = new Date();
    let start = req.query.startDate ? new Date(req.query.startDate) : monthStart(now);
    let end = req.query.endDate ? new Date(new Date(req.query.endDate).setHours(23, 59, 59, 999)) : monthEnd(now);
    if (start > end) [start, end] = [end, start];

    const spanMs = end - start;
    const prevStart = new Date(start.getTime() - spanMs - 1);
    const prevEnd = new Date(start.getTime() - 1);

    const [revenue, expenses, prevRevenue, prevExpenses] = await Promise.all([
      revenueBetween(companyId, start, end),
      expensesBetween(companyId, start, end),
      revenueBetween(companyId, prevStart, prevEnd),
      expensesBetween(companyId, prevStart, prevEnd),
    ]);

    const netProfit = revenue.total - expenses.total;
    const prevProfit = prevRevenue.total - prevExpenses.total;

    // 6-month trend (revenue vs expenses)
    const anchor = monthStart(end);
    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const ms = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
      const me = new Date(anchor.getFullYear(), anchor.getMonth() - i + 1, 0, 23, 59, 59, 999);
      // eslint-disable-next-line no-await-in-loop
      const [rev, exp] = await Promise.all([revenueBetween(companyId, ms, me), expensesBetween(companyId, ms, me)]);
      monthly.push({
        month: ms.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
        revenue: rev.total, expenses: exp.total, profit: rev.total - exp.total,
      });
    }

    const byCategoryObj = expenses.byCategory.reduce((a, c) => { a[c.category] = c.total; return a; }, {});

    res.status(200).json({
      success: true,
      data: {
        period: { start, end },
        revenue: { invoices: revenue.invoices, orders: revenue.orders, total: revenue.total },
        expenses: { total: expenses.total, byCategory: byCategoryObj, breakdown: expenses.byCategory },
        grossProfit: netProfit,
        netProfit,
        profitMargin: revenue.total ? Math.round((netProfit / revenue.total) * 1000) / 10 : 0,
        comparison: {
          revenueChange: pctChange(revenue.total, prevRevenue.total),
          expenseChange: pctChange(expenses.total, prevExpenses.total),
          profitChange: pctChange(netProfit, prevProfit),
        },
        monthly,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /expenses/:id ─────────────────────────────────────────────────
exports.getExpense = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Expense not found.', 404));
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('createdBy', 'name').populate('approvedBy', 'name').lean();
    if (!expense) return next(new AppError('Expense not found.', 404));
    res.status(200).json({ success: true, data: expense });
  } catch (err) { next(err); }
};

// ── POST /expenses ────────────────────────────────────────────────────
exports.createExpense = async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (!body.title || !body.title.trim()) return next(new AppError('Title is required.', 400));
    if (!(Number(body.amount) > 0)) return next(new AppError('Amount must be greater than zero.', 400));
    if (!body.date) body.date = new Date();
    if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (body.isRecurring === 'true') body.isRecurring = true;
    if (body.isRecurring === 'false' || !body.isRecurring) { body.isRecurring = false; body.recurringInterval = null; }

    if (req.file) {
      try { body.receipt = await uploadReceiptFile(req.file.path, req.companyId); }
      catch (e) { logger.warn(`Receipt upload failed: ${e.message}`); }
    }

    const expense = await Expense.create({
      ...body,
      companyId: req.companyId,
      createdBy: req.user._id,
      approvedBy: body.status === 'approved' || !body.status ? req.user._id : undefined,
    });

    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'expense.create', resource: 'Expense', resourceId: expense._id, description: `${expense.title} — ${expense.currency} ${expense.amount}`, ip: req.ip });
    res.status(201).json({ success: true, data: expense });
  } catch (err) { next(err); }
};

// ── PUT /expenses/:id ─────────────────────────────────────────────────
exports.updateExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!expense) return next(new AppError('Expense not found.', 404));

    const body = { ...req.body };
    delete body.companyId; delete body.createdBy;
    if (body.amount != null && !(Number(body.amount) > 0)) return next(new AppError('Amount must be greater than zero.', 400));
    if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (body.isRecurring === 'true') body.isRecurring = true;
    if (body.isRecurring === 'false') { body.isRecurring = false; body.recurringInterval = null; }

    if (req.file) {
      try { body.receipt = await uploadReceiptFile(req.file.path, req.companyId); }
      catch (e) { logger.warn(`Receipt upload failed: ${e.message}`); }
    }

    Object.assign(expense, body);
    await expense.save();

    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'expense.update', resource: 'Expense', resourceId: expense._id, ip: req.ip });
    res.status(200).json({ success: true, data: expense });
  } catch (err) { next(err); }
};

// ── DELETE /expenses/:id (hard) ──────────────────────────────────────
exports.deleteExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!expense) return next(new AppError('Expense not found.', 404));
    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'expense.delete', resource: 'Expense', resourceId: expense._id, description: expense.title, ip: req.ip });
    res.status(200).json({ success: true, message: 'Expense deleted.' });
  } catch (err) { next(err); }
};
