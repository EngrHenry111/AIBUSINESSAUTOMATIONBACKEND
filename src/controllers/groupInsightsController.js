'use strict';

const mongoose = require('mongoose');
const BranchReport = require('../models/BranchReport');
const GroupPosSettlement = require('../models/GroupPosSettlement');
const { AppError } = require('../middleware/errorMiddleware');
const { helpers } = require('./groupController');

const { isGroupLevel, userBranchRole, visibleBranches, loadBranch, ymd, todayYmd, dayStart, addDays } = helpers;
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const LIVE = { status: { $nin: ['draft', 'rejected'] } };

function range(req, defaultDays) {
  const to = String(req.query.to || todayYmd()).slice(0, 10);
  const from = String(req.query.from || addDays(to, -(defaultDays - 1))).slice(0, 10);
  return { from, to };
}

async function scopedBranches(req) {
  const branches = await visibleBranches(req);
  if (!req.query.branchId) return branches;
  return branches.filter((b) => String(b._id) === String(req.query.branchId));
}

// ── Profit ─────────────────────────────────────────────────────────────
// GET /group/profit?from=&to=&branchId=
exports.profit = async (req, res, next) => {
  try {
    const { from, to } = range(req, 30);
    const branches = await scopedBranches(req);
    const reports = await BranchReport.find({
      companyId: req.companyId, branchId: { $in: branches.map((b) => b._id) }, ...LIVE,
      reportDate: { $gte: dayStart(from), $lte: dayStart(to) },
    }).select('branchId businessLine totals pumps.product pumps.litres pumps.amount pumps.cost items.description items.unit items.quantity items.amount items.cost items.unitCost pumps.costPerLitre').lean();

    const byBranch = new Map(branches.map((b) => [String(b._id), {
      _id: b._id, name: b.name, businessLine: b.businessLine,
      sales: 0, cost: 0, grossProfit: 0, expenses: 0, netProfit: 0, litres: 0, fuelSales: 0, fuelCost: 0, linesWithoutCost: 0,
    }]));
    const products = {};
    const goods = {};
    reports.forEach((r) => {
      const b = byBranch.get(String(r.branchId));
      if (!b) return;
      b.sales += r.totals.expectedSales || 0;
      b.cost += r.totals.cost || 0;
      b.grossProfit += r.totals.grossProfit ?? (r.totals.expectedSales || 0);
      b.expenses += r.totals.expenses || 0;
      b.netProfit += r.totals.netProfit ?? ((r.totals.expectedSales || 0) - (r.totals.expenses || 0));
      (r.pumps || []).forEach((p) => {
        b.litres += p.litres || 0;
        b.fuelSales += p.amount || 0;
        b.fuelCost += p.cost || 0;
        if (!p.costPerLitre && p.litres) b.linesWithoutCost += 1;
        const k = p.product || 'PMS';
        products[k] = products[k] || { product: k, litres: 0, sales: 0, cost: 0 };
        products[k].litres += p.litres || 0;
        products[k].sales += p.amount || 0;
        products[k].cost += p.cost || 0;
      });
      (r.items || []).forEach((it) => {
        if (!it.unitCost && it.quantity) b.linesWithoutCost += 1;
        const k = `${it.description}|${it.unit || ''}`;
        goods[k] = goods[k] || { description: it.description, unit: it.unit, quantity: 0, sales: 0, cost: 0 };
        goods[k].quantity += it.quantity || 0;
        goods[k].sales += it.amount || 0;
        goods[k].cost += it.cost || 0;
      });
    });

    const finish = (x) => ({ ...x, grossProfit: round2(x.sales - x.cost), margin: x.sales ? round2(((x.sales - x.cost) / x.sales) * 100) : 0 });
    const branchRows = [...byBranch.values()].map((b) => ({
      ...b,
      margin: b.sales ? round2((b.grossProfit / b.sales) * 100) : 0,
      marginPerLitre: b.litres ? round2((b.fuelSales - b.fuelCost) / b.litres) : null,
    })).sort((a, b) => b.netProfit - a.netProfit);
    const sum = (k) => round2(branchRows.reduce((s, b) => s + (b[k] || 0), 0));
    const totals = { sales: sum('sales'), cost: sum('cost'), grossProfit: sum('grossProfit'), expenses: sum('expenses'), netProfit: sum('netProfit'), litres: sum('litres'), linesWithoutCost: sum('linesWithoutCost') };
    totals.margin = totals.sales ? round2((totals.grossProfit / totals.sales) * 100) : 0;

    res.json({
      success: true,
      data: {
        period: { from, to },
        totals,
        branches: branchRows,
        fuel: Object.values(products).map((p) => ({ ...finish(p), perLitre: p.litres ? round2((p.sales - p.cost) / p.litres) : 0 })).sort((a, b) => b.sales - a.sales),
        goods: Object.values(goods).map(finish).sort((a, b) => b.grossProfit - a.grossProfit).slice(0, 30),
      },
    });
  } catch (err) { next(err); }
};

// ── POS settlement check ───────────────────────────────────────────────
// GET /group/pos?from=&to=&branchId=
// Per branch per trading day: POS recorded on reports vs what the bank paid
// (plus charges it deducted). Days with POS but no settlement after 2 days
// are flagged as unsettled.
exports.posList = async (req, res, next) => {
  try {
    const { from, to } = range(req, 14);
    const branches = await scopedBranches(req);
    const ids = branches.map((b) => b._id);
    const [recorded, settlements] = await Promise.all([
      BranchReport.aggregate([
        { $match: { companyId: new mongoose.Types.ObjectId(String(req.companyId)), branchId: { $in: ids }, ...LIVE, reportDate: { $gte: dayStart(from), $lte: dayStart(to) } } },
        { $group: { _id: { branchId: '$branchId', date: '$reportDate' }, pos: { $sum: '$collections.pos' } } },
      ]),
      GroupPosSettlement.find({ companyId: req.companyId, branchId: { $in: ids }, date: { $gte: dayStart(from), $lte: dayStart(to) } }).sort({ date: 1 }).lean(),
    ]);
    const names = new Map(branches.map((b) => [String(b._id), b.name]));
    const rows = new Map();
    const key = (b, d) => `${b}|${ymd(d)}`;
    recorded.forEach((r) => {
      if (!r.pos) return;
      rows.set(key(r._id.branchId, r._id.date), { branchId: r._id.branchId, branchName: names.get(String(r._id.branchId)), date: ymd(r._id.date), recorded: round2(r.pos), settled: 0, charges: 0, settlements: [] });
    });
    settlements.forEach((s) => {
      const k = key(s.branchId, s.date);
      if (!rows.has(k)) rows.set(k, { branchId: s.branchId, branchName: names.get(String(s.branchId)), date: ymd(s.date), recorded: 0, settled: 0, charges: 0, settlements: [] });
      const row = rows.get(k);
      row.settled = round2(row.settled + s.settledAmount);
      row.charges = round2(row.charges + (s.charges || 0));
      row.settlements.push(s);
    });
    const today = todayYmd();
    const data = [...rows.values()].map((r) => {
      const difference = round2(r.settled + r.charges - r.recorded);
      let status;
      if (!r.settlements.length) status = r.date >= addDays(today, -1) ? 'pending' : 'unsettled';
      else if (Math.abs(difference) < 100) status = 'matched';
      else status = difference < 0 ? 'short' : 'over';
      return { ...r, difference, status };
    }).sort((a, b) => (b.date.localeCompare(a.date)) || a.branchName.localeCompare(b.branchName));
    const s = (f) => round2(data.reduce((t, r) => t + f(r), 0));
    res.json({
      success: true,
      data,
      totals: {
        recorded: s((r) => r.recorded), settled: s((r) => r.settled), charges: s((r) => r.charges),
        unsettled: s((r) => (r.status === 'unsettled' ? r.recorded : 0)),
        short: s((r) => (r.status === 'short' ? -r.difference : 0)),
        problemDays: data.filter((r) => ['unsettled', 'short'].includes(r.status)).length,
      },
      period: { from, to },
    });
  } catch (err) { next(err); }
};

// POST /group/pos  { branchId, date, terminalId, bank, settledAmount, charges, settledOn, reference, note }
exports.posCreate = async (req, res, next) => {
  try {
    const branch = await loadBranch(req, req.body.branchId);
    if (!['owner', 'manager'].includes(userBranchRole(branch, req.user))) return next(new AppError('Only the owner or this branch\'s manager can record settlements.', 403));
    const amount = num(req.body.settledAmount);
    if (amount <= 0) return next(new AppError('Enter the amount the bank settled.', 400));
    if (!req.body.date) return next(new AppError('Choose the trading day these POS sales were made.', 400));
    const s = await GroupPosSettlement.create({
      companyId: req.companyId, branchId: branch._id,
      date: dayStart(String(req.body.date).slice(0, 10)),
      terminalId: String(req.body.terminalId || '').trim().slice(0, 40), bank: String(req.body.bank || '').trim().slice(0, 60),
      settledAmount: amount, charges: Math.max(0, num(req.body.charges)),
      settledOn: req.body.settledOn ? dayStart(String(req.body.settledOn).slice(0, 10)) : undefined,
      reference: String(req.body.reference || '').trim().slice(0, 80), note: String(req.body.note || '').trim().slice(0, 500), byName: req.user.name,
    });
    res.status(201).json({ success: true, data: s });
  } catch (err) { next(err); }
};

exports.posDelete = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Not found.', 404));
    const s = await GroupPosSettlement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!s) return next(new AppError('Not found.', 404));
    const branch = await loadBranch(req, s.branchId);
    if (!['owner', 'manager'].includes(userBranchRole(branch, req.user))) return next(new AppError('Not allowed.', 403));
    await s.deleteOne();
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.isGroupLevel = isGroupLevel;
