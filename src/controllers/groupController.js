'use strict';

const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const BranchReport = require('../models/BranchReport');
const User = require('../models/User');
const { DEFAULT_BRANCH_DEPARTMENTS, DEFAULT_SHIFTS } = require('../models/Branch');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { complete, MODELS } = require('../services/groqService');
const logger = require('../utils/logger');
const { alertIfShort, SHORTAGE_ALERT, METER_GAP_ALERT } = require('../utils/groupAlerts');

// ── Multi-branch group operations ──────────────────────────────────────
// Owner (company_owner / super_admin) = group level: sees every branch and
// gives final approval. Everyone else only sees branches where they are the
// manager, a department head, or listed staff. Branch managers give the
// first approval for their own branch.

const TZ = 'Africa/Lagos';

const isGroupLevel = (user) => ['company_owner', 'super_admin'].includes(user.role);
const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const todayYmd = () => ymd(new Date());
const dayStart = (s) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s, n) => { const d = dayStart(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const idEq = (a, b) => a && b && String(a) === String(b);

function userBranchRole(branch, user) {
  if (isGroupLevel(user)) return 'owner';
  if (idEq(branch.managerId, user._id)) return 'manager';
  if (branch.departments.some((d) => idEq(d.headId, user._id))) return 'head';
  if (branch.staff.some((s) => idEq(s, user._id))) return 'staff';
  return null;
}

async function visibleBranches(req) {
  const all = await Branch.find({ companyId: req.companyId }).sort({ businessLine: 1, name: 1 });
  return isGroupLevel(req.user) ? all : all.filter((b) => userBranchRole(b, req.user));
}

async function loadBranch(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Branch not found.', 404);
  const branch = await Branch.findOne({ _id: id, companyId: req.companyId });
  if (!branch || !userBranchRole(branch, req.user)) throw new AppError('Branch not found.', 404);
  return branch;
}

async function loadReport(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Report not found.', 404);
  const report = await BranchReport.findOne({ _id: id, companyId: req.companyId });
  if (!report) throw new AppError('Report not found.', 404);
  const branch = await Branch.findById(report.branchId);
  if (!branch || !userBranchRole(branch, req.user)) throw new AppError('Report not found.', 404);
  return { report, branch };
}

const pickReportFields = (body) => ({
  department: body.department,
  shift: body.shift && body.shift.name ? {
    name: String(body.shift.name).slice(0, 40),
    start: String(body.shift.start || '').slice(0, 5),
    end: String(body.shift.end || '').slice(0, 5),
  } : undefined,
  attendantName: body.attendantName !== undefined ? String(body.attendantName || '').trim().slice(0, 120) : undefined,
  attendantId: body.attendantId !== undefined ? (mongoose.isValidObjectId(body.attendantId) ? body.attendantId : null) : undefined,
  transfers: Array.isArray(body.transfers) ? body.transfers : undefined,
  reportDate: body.reportDate ? dayStart(String(body.reportDate).slice(0, 10)) : undefined,
  pumps: Array.isArray(body.pumps) ? body.pumps : undefined,
  items: Array.isArray(body.items) ? body.items : undefined,
  collections: body.collections,
  expenses: Array.isArray(body.expenses) ? body.expenses : undefined,
  notes: body.notes,
});

// Latest closing meter per nozzle from shifts BEFORE (date, shiftStart).
// Night shifts are dated by the day they start, so "06:00 tomorrow" comes
// after "22:00 today" through the date, and shifts on the same day order by
// start time.
async function previousClosings(branchId, date, shiftStart, excludeId, codes) {
  const out = {};
  const base = {
    branchId,
    status: { $nin: ['draft', 'rejected'] },
    $or: [{ reportDate: { $lt: date } }, { reportDate: date, 'shift.start': { $lt: shiftStart || '99:99' } }],
  };
  if (excludeId && mongoose.isValidObjectId(excludeId)) base._id = { $ne: excludeId };
  await Promise.all(codes.map(async (code) => {
    const prev = await BranchReport.findOne({ ...base, 'pumps.nozzle': code })
      .sort({ reportDate: -1, 'shift.start': -1, createdAt: -1 })
      .select('pumps.nozzle pumps.closingMeter attendantName shift reportDate').lean();
    const line = prev?.pumps.find((p) => p.nozzle === code);
    if (line) out[code] = { closing: line.closingMeter, attendant: prev.attendantName, shift: prev.shift?.name, date: ymd(prev.reportDate) };
  }));
  return out;
}

async function stampMeterGaps(report) {
  const codes = [...new Set(report.pumps.map((p) => p.nozzle).filter(Boolean))];
  if (!codes.length) return;
  const prev = await previousClosings(report.branchId, report.reportDate, report.shift?.start, report._id, codes);
  report.pumps.forEach((p) => {
    const last = prev[p.nozzle];
    p.prevClosing = last ? last.closing : null;
    p.meterGap = last ? Math.round((p.openingMeter - last.closing) * 100) / 100 : 0;
  });
}

function submitReport(report, branch, user) {
  report.submittedAt = new Date();
  report.approvals = [];
  // No branch manager assigned → the owner is the only approver.
  if (branch.managerId) report.approvals.push({ level: 'branch_manager', status: 'pending' });
  report.approvals.push({ level: 'owner', status: 'pending' });
  report.status = branch.managerId ? 'pending_branch' : 'pending_owner';
  report.trail.push({ action: 'submitted', byName: user.name });
}

async function nextLedgerNumber(companyId) {
  const year = new Date().getFullYear();
  const count = await BranchReport.countDocuments({ companyId, ledgerNumber: { $regex: `^SL/${year}/` } });
  return `SL/${year}/${String(count + 1).padStart(5, '0')}`;
}

// ── GET /group/me ──────────────────────────────────────────────────────
exports.me = async (req, res, next) => {
  try {
    const branches = await visibleBranches(req);
    res.json({
      success: true,
      data: {
        groupLevel: isGroupLevel(req.user),
        branches: branches.map((b) => ({ _id: b._id, name: b.name, businessLine: b.businessLine, role: userBranchRole(b, req.user) })),
      },
    });
  } catch (err) { next(err); }
};

// ── Branches ───────────────────────────────────────────────────────────
exports.listBranches = async (req, res, next) => {
  try {
    const branches = await visibleBranches(req);
    await Branch.populate(branches, [
      { path: 'managerId', select: 'name email' },
      { path: 'staff', select: 'name email' },
      { path: 'departments.headId', select: 'name email' },
    ]);
    res.json({ success: true, data: branches });
  } catch (err) { next(err); }
};

exports.members = async (req, res, next) => {
  try {
    const users = await User.find({ companyId: req.companyId, role: { $ne: 'customer' }, status: 'active' })
      .select('name email role department').sort({ name: 1 });
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
};

// GET /group/branches/:id/last-meters?date=YYYY-MM-DD&shiftStart=HH:mm
// Prefills each nozzle's opening meter with the previous shift's closing.
exports.lastMeters = async (req, res, next) => {
  try {
    const branch = await loadBranch(req, req.params.id);
    const date = dayStart(String(req.query.date || todayYmd()).slice(0, 10));
    const codes = branch.nozzles.map((n) => n.code);
    const data = await previousClosings(branch._id, date, req.query.shiftStart, req.query.excludeId, codes);
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

function branchPayload(body) {
  const out = {};
  ['name', 'code', 'businessLine', 'address', 'city', 'state', 'dailySalesTarget', 'fuelPrices', 'status'].forEach((k) => {
    if (body[k] !== undefined) out[k] = body[k];
  });
  if (body.managerId !== undefined) out.managerId = body.managerId || null;
  if (Array.isArray(body.staff)) out.staff = body.staff.filter(Boolean);
  if (Array.isArray(body.nozzles)) {
    out.nozzles = body.nozzles
      .filter((n) => n && String(n.code || '').trim())
      .map((n) => ({ code: String(n.code).trim().toUpperCase(), pump: String(n.pump || n.code).trim(), product: n.product || 'PMS' }));
  }
  if (Array.isArray(body.shifts)) {
    out.shifts = body.shifts
      .filter((x) => x && String(x.name || '').trim() && /^\d{2}:\d{2}$/.test(x.start || '') && /^\d{2}:\d{2}$/.test(x.end || ''))
      .map((x) => ({ name: String(x.name).trim(), start: x.start, end: x.end }));
  }
  if (Array.isArray(body.departments)) {
    out.departments = body.departments
      .filter((d) => d && String(d.name || '').trim())
      .map((d) => ({ ...(d._id ? { _id: d._id } : {}), name: String(d.name).trim(), headId: d.headId || null }));
  }
  return out;
}

exports.createBranch = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can add branches.', 403));
    const data = branchPayload(req.body);
    if (!data.name) return next(new AppError('Branch name is required.', 400));
    if (!data.departments?.length) {
      data.departments = (DEFAULT_BRANCH_DEPARTMENTS[data.businessLine] || DEFAULT_BRANCH_DEPARTMENTS.general).map((name) => ({ name }));
    }
    if (data.businessLine !== 'filling_station') data.nozzles = [];
    if (!data.shifts?.length) data.shifts = DEFAULT_SHIFTS.map((x) => ({ ...x }));
    const branch = await Branch.create({ ...data, companyId: req.companyId });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.branch_create', description: branch.name, ip: req.ip });
    res.status(201).json({ success: true, data: branch });
  } catch (err) { next(err); }
};

exports.updateBranch = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can edit branches.', 403));
    const branch = await loadBranch(req, req.params.id);
    branch.set(branchPayload(req.body));
    await branch.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.branch_update', description: branch.name, ip: req.ip });
    res.json({ success: true, data: branch });
  } catch (err) { next(err); }
};

exports.deleteBranch = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can remove branches.', 403));
    const branch = await loadBranch(req, req.params.id);
    const approved = await BranchReport.countDocuments({ branchId: branch._id, status: 'approved' });
    if (approved) {
      // Approved sales are part of the final record — deactivate instead of deleting history.
      branch.status = 'inactive';
      await branch.save();
      return res.json({ success: true, data: branch, message: 'Branch has approved sales, so it was deactivated instead of deleted.' });
    }
    await BranchReport.deleteMany({ branchId: branch._id });
    await branch.deleteOne();
    res.json({ success: true, message: 'Branch removed.' });
  } catch (err) { next(err); }
};

// ── Reports ────────────────────────────────────────────────────────────
exports.listReports = async (req, res, next) => {
  try {
    const branches = await visibleBranches(req);
    const branchIds = branches.map((b) => b._id);
    const q = { companyId: req.companyId, branchId: { $in: branchIds } };
    const { branchId, status, department, from, to, awaiting } = req.query;
    if (branchId) q.branchId = branchIds.find((id) => idEq(id, branchId)) || null;
    if (status) q.status = status;
    if (department) q.department = department;
    if (from || to) {
      q.reportDate = {};
      if (from) q.reportDate.$gte = dayStart(from);
      if (to) q.reportDate.$lte = dayStart(to);
    }
    // Drafts are private to whoever is preparing them.
    if (!status) q.$or = [{ status: { $ne: 'draft' } }, { preparedBy: req.user._id }];

    if (awaiting === 'me') {
      // Reports waiting on this user's approval.
      if (isGroupLevel(req.user)) {
        q.status = { $in: ['pending_branch', 'pending_owner'] };
      } else {
        const managed = branches.filter((b) => idEq(b.managerId, req.user._id)).map((b) => b._id);
        q.branchId = { $in: managed };
        q.status = 'pending_branch';
      }
    }

    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const reports = await BranchReport.find(q)
      .select('-trail -pumps -items -expenses')
      .sort({ reportDate: -1, createdAt: -1 })
      .limit(limit);
    res.json({ success: true, data: reports });
  } catch (err) { next(err); }
};

exports.getReport = async (req, res, next) => {
  try {
    const { report, branch } = await loadReport(req, req.params.id);
    const role = userBranchRole(branch, req.user);
    const canApprove = (report.status === 'pending_branch' && (role === 'manager' || role === 'owner'))
      || (report.status === 'pending_owner' && role === 'owner');
    const canEdit = ['draft', 'rejected'].includes(report.status)
      && (idEq(report.preparedBy, req.user._id) || role === 'owner' || role === 'manager');
    res.json({ success: true, data: report, permissions: { canApprove, canEdit, role } });
  } catch (err) { next(err); }
};

exports.createReport = async (req, res, next) => {
  try {
    const branch = await loadBranch(req, req.body.branchId);
    const fields = pickReportFields(req.body);
    if (!fields.department) return next(new AppError('Select a department.', 400));
    if (!fields.reportDate) fields.reportDate = dayStart(todayYmd());
    if (!(fields.pumps?.length || fields.items?.length)) {
      return next(new AppError('Add at least one pump reading or item sold.', 400));
    }

    const dateKey = ymd(fields.reportDate).replace(/-/g, '');
    const seq = await BranchReport.countDocuments({ branchId: branch._id, reportDate: fields.reportDate }) + 1;
    const report = new BranchReport({
      ...fields,
      companyId: req.companyId,
      branchId: branch._id,
      branchName: branch.name,
      businessLine: branch.businessLine,
      referenceNumber: `DSR/${branch.code || 'BR'}/${dateKey}/${fields.shift?.name ? fields.shift.name.charAt(0).toUpperCase() : ''}${seq}`,
      preparedBy: req.user._id,
      preparedByName: req.user.name,
      trail: [{ action: 'created', byName: req.user.name }],
    });
    if (req.body.submit) submitReport(report, branch, req.user);
    await stampMeterGaps(report);
    await report.save();
    if (req.body.submit) alertIfShort(report, branch);
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.report_create', description: `${report.referenceNumber} · ${branch.name}`, ip: req.ip });
    res.status(201).json({ success: true, data: report });
  } catch (err) { next(err); }
};

exports.updateReport = async (req, res, next) => {
  try {
    const { report, branch } = await loadReport(req, req.params.id);
    const role = userBranchRole(branch, req.user);
    if (!['draft', 'rejected'].includes(report.status)) return next(new AppError('Only drafts or rejected reports can be edited.', 400));
    if (!idEq(report.preparedBy, req.user._id) && role !== 'owner' && role !== 'manager') {
      return next(new AppError('You can only edit reports you prepared.', 403));
    }
    const fields = pickReportFields(req.body);
    Object.entries(fields).forEach(([k, v]) => { if (v !== undefined) report[k] = v; });
    report.trail.push({ action: 'edited', byName: req.user.name });
    if (req.body.submit) submitReport(report, branch, req.user);
    else if (report.status === 'rejected') report.status = 'draft';
    await stampMeterGaps(report);
    await report.save();
    if (req.body.submit) alertIfShort(report, branch);
    res.json({ success: true, data: report });
  } catch (err) { next(err); }
};

exports.submit = async (req, res, next) => {
  try {
    const { report, branch } = await loadReport(req, req.params.id);
    if (!['draft', 'rejected'].includes(report.status)) return next(new AppError('Report is already submitted.', 400));
    submitReport(report, branch, req.user);
    await stampMeterGaps(report);
    await report.save();
    alertIfShort(report, branch);
    res.json({ success: true, data: report });
  } catch (err) { next(err); }
};

exports.approve = async (req, res, next) => {
  try {
    const { report, branch } = await loadReport(req, req.params.id);
    const role = userBranchRole(branch, req.user);
    const comment = String(req.body.comment || '').slice(0, 1000);

    let level;
    if (report.status === 'pending_branch' && (role === 'manager' || role === 'owner')) level = 'branch_manager';
    else if (report.status === 'pending_owner' && role === 'owner') level = 'owner';
    else return next(new AppError('This report is not awaiting your approval.', 403));

    const step = report.approvals.find((a) => a.level === level);
    Object.assign(step, { status: 'approved', byId: req.user._id, byName: req.user.name, comment, at: new Date() });
    report.trail.push({ action: `approved (${level === 'owner' ? 'final' : 'branch'})`, byName: req.user.name, comment });

    if (level === 'branch_manager') {
      report.status = 'pending_owner';
    } else {
      report.status = 'approved';
      report.approvedAt = new Date();
      report.ledgerNumber = await nextLedgerNumber(req.companyId);
    }
    await report.save();
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id, action: `group.report_approve_${level}`,
      description: `${report.referenceNumber}${report.ledgerNumber ? ` → ${report.ledgerNumber}` : ''}`, ip: req.ip,
    });
    res.json({ success: true, data: report });
  } catch (err) { next(err); }
};

exports.reject = async (req, res, next) => {
  try {
    const { report, branch } = await loadReport(req, req.params.id);
    const role = userBranchRole(branch, req.user);
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (!reason) return next(new AppError('Give a reason so the department knows what to fix.', 400));

    let level;
    if (report.status === 'pending_branch' && (role === 'manager' || role === 'owner')) level = 'branch_manager';
    else if (report.status === 'pending_owner' && role === 'owner') level = 'owner';
    else return next(new AppError('This report is not awaiting your approval.', 403));

    const step = report.approvals.find((a) => a.level === level);
    Object.assign(step, { status: 'rejected', byId: req.user._id, byName: req.user.name, comment: reason, at: new Date() });
    report.status = 'rejected';
    report.trail.push({ action: 'rejected', byName: req.user.name, comment: reason });
    await report.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.report_reject', description: report.referenceNumber, ip: req.ip });
    res.json({ success: true, data: report });
  } catch (err) { next(err); }
};

// Owner approves every report currently at the final step in one go.
exports.bulkApprove = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can bulk-approve.', 403));
    const ids = (req.body.ids || []).filter((id) => mongoose.isValidObjectId(id));
    const reports = await BranchReport.find({ _id: { $in: ids }, companyId: req.companyId, status: { $in: ['pending_branch', 'pending_owner'] } })
      .sort({ reportDate: 1 });
    for (const report of reports) {
      for (const step of report.approvals) {
        if (step.status === 'pending') Object.assign(step, { status: 'approved', byId: req.user._id, byName: req.user.name, at: new Date() });
      }
      report.status = 'approved';
      report.approvedAt = new Date();
      report.ledgerNumber = await nextLedgerNumber(req.companyId);
      report.trail.push({ action: 'approved (final, bulk)', byName: req.user.name });
      await report.save();
    }
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.report_bulk_approve', description: `${reports.length} reports`, ip: req.ip });
    res.json({ success: true, data: { approved: reports.length } });
  } catch (err) { next(err); }
};

// ── Overview (owner command center) ──────────────────────────────────
async function buildOverview(req) {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const to = todayYmd();
  const from = addDays(to, -(days - 1));
  const branches = (await visibleBranches(req)).filter((b) => b.status === 'active');
  const branchIds = branches.map((b) => b._id);

  const reports = await BranchReport.find({
    companyId: req.companyId,
    branchId: { $in: branchIds },
    status: { $ne: 'draft' },
    reportDate: { $gte: dayStart(from), $lte: dayStart(to) },
  }).select('branchId branchName businessLine department status reportDate totals referenceNumber attendantName shift').lean();

  const live = reports.filter((r) => r.status !== 'rejected');
  const sum = (arr, f) => arr.reduce((s, r) => s + (f(r) || 0), 0);

  const perBranch = branches.map((b) => {
    const rs = live.filter((r) => idEq(r.branchId, b._id));
    const sales = sum(rs, (r) => r.totals.expectedSales);
    const target = (b.dailySalesTarget || 0) * days;
    const todays = rs.filter((r) => ymd(r.reportDate) === to);
    const reportedDepts = new Set(todays.map((r) => r.department));
    return {
      _id: b._id,
      name: b.name,
      city: b.city,
      businessLine: b.businessLine,
      sales,
      approvedSales: sum(rs.filter((r) => r.status === 'approved'), (r) => r.totals.expectedSales),
      collected: sum(rs, (r) => r.totals.collected),
      variance: sum(rs, (r) => r.totals.variance),
      litres: sum(rs, (r) => r.totals.litres),
      pending: rs.filter((r) => r.status.startsWith('pending')).length,
      target,
      achievement: target ? Math.round((sales / target) * 100) : null,
      todaySales: sum(todays, (r) => r.totals.expectedSales),
      departmentsReportedToday: reportedDepts.size,
      departmentsTotal: b.departments.length,
      missingToday: b.departments.map((d) => d.name).filter((n) => !reportedDepts.has(n)),
    };
  }).sort((a, b) => b.sales - a.sales);

  // Daily trend, split by business line.
  const trend = [];
  for (let i = 0; i < days; i += 1) {
    const d = addDays(from, i);
    const row = { date: d, filling_station: 0, building_materials: 0, general: 0, approved: 0 };
    live.filter((r) => ymd(r.reportDate) === d).forEach((r) => {
      row[r.businessLine || 'general'] += r.totals.expectedSales;
      if (r.status === 'approved') row.approved += r.totals.expectedSales;
    });
    trend.push(row);
  }

  const byLine = ['filling_station', 'building_materials', 'general']
    .map((line) => ({ line, sales: sum(live.filter((r) => r.businessLine === line), (r) => r.totals.expectedSales) }))
    .filter((l) => l.sales > 0);

  const alerts = [];
  live.filter((r) => r.totals.variance <= -SHORTAGE_ALERT).sort((a, b) => a.totals.variance - b.totals.variance).slice(0, 8)
    .forEach((r) => alerts.push({
      type: 'shortage', severity: r.totals.variance <= -SHORTAGE_ALERT * 4 ? 'high' : 'medium',
      reportId: r._id, branch: r.branchName, department: r.department, date: ymd(r.reportDate), amount: r.totals.variance,
      message: `${r.branchName} · ${r.attendantName ? `${r.attendantName} (${r.shift?.name || ""} shift)` : r.department} is short ₦${Math.abs(Math.round(r.totals.variance)).toLocaleString()} on ${ymd(r.reportDate)}`,
    }));
  perBranch.filter((b) => b.missingToday.length).forEach((b) => alerts.push({
    type: 'missing', severity: b.departmentsReportedToday === 0 ? 'high' : 'low', branch: b.name,
    message: b.departmentsReportedToday === 0
      ? `${b.name} has not submitted any report today`
      : `${b.name}: waiting on ${b.missingToday.join(', ')}`,
  }));
  reports.filter((r) => r.status === 'rejected').slice(0, 5).forEach((r) => alerts.push({
    type: 'rejected', severity: 'low', reportId: r._id, branch: r.branchName,
    message: `${r.referenceNumber} (${r.department}) was sent back for correction`,
  }));
  perBranch.filter((b) => b.achievement !== null && b.achievement < 80).forEach((b) => alerts.push({
    type: 'target', severity: 'medium', branch: b.name,
    message: `${b.name} is at ${b.achievement}% of its sales target for this period`,
  }));

  // Attendant watch: who handles the money on each shift, and how often they come up short.
  const att = {};
  live.filter((r) => r.attendantName).forEach((r) => {
    const key = `${r.attendantName}|${r.branchName}`;
    att[key] = att[key] || { name: r.attendantName, branch: r.branchName, shifts: 0, sales: 0, variance: 0, shortShifts: 0, meterGapLitres: 0 };
    const a = att[key];
    a.shifts += 1;
    a.sales += r.totals.expectedSales;
    a.variance += r.totals.variance;
    a.meterGapLitres += r.totals.meterGapLitres || 0;
    if (r.totals.variance <= -5000) a.shortShifts += 1;
  });
  const attendants = Object.values(att).sort((a, b) => a.variance - b.variance);
  attendants.filter((a) => a.shortShifts >= 3).slice(0, 5).forEach((a) => alerts.push({
    type: 'attendant', severity: a.variance <= -SHORTAGE_ALERT * 4 ? 'high' : 'medium', branch: a.branch,
    message: `${a.name} (${a.branch}) was short on ${a.shortShifts} of ${a.shifts} shifts, ₦${Math.abs(Math.round(a.variance)).toLocaleString()} in total`,
  }));
  live.filter((r) => (r.totals.meterGapLitres || 0) >= METER_GAP_ALERT).slice(0, 6).forEach((r) => alerts.push({
    type: 'meter', severity: 'high', reportId: r._id, branch: r.branchName, date: ymd(r.reportDate),
    message: `Meter handover gap of ${Math.round(r.totals.meterGapLitres).toLocaleString()} L at ${r.branchName}${r.shift?.name ? `, ${r.shift.name} shift` : ''} on ${ymd(r.reportDate)}${r.attendantName ? ` (${r.attendantName})` : ''}: opening didn't match the last closing`,
  }));
  const sevRank = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  const todayLive = live.filter((r) => ymd(r.reportDate) === to);
  return {
    period: { from, to, days },
    kpis: {
      sales: sum(live, (r) => r.totals.expectedSales),
      approvedSales: sum(live.filter((r) => r.status === 'approved'), (r) => r.totals.expectedSales),
      collected: sum(live, (r) => r.totals.collected),
      expenses: sum(live, (r) => r.totals.expenses),
      variance: sum(live, (r) => r.totals.variance),
      shortages: sum(live.filter((r) => r.totals.variance < 0), (r) => r.totals.variance),
      meterGapLitres: sum(live, (r) => r.totals.meterGapLitres),
      litres: sum(live, (r) => r.totals.litres),
      pendingApprovals: live.filter((r) => r.status.startsWith('pending')).length,
      todaySales: sum(todayLive, (r) => r.totals.expectedSales),
      branches: branches.length,
      branchesReportedToday: perBranch.filter((b) => b.departmentsReportedToday > 0).length,
    },
    perBranch,
    byLine,
    trend,
    alerts,
    attendants: attendants.slice(0, 15),
  };
}

exports.overview = async (req, res, next) => {
  try {
    res.json({ success: true, data: await buildOverview(req) });
  } catch (err) { next(err); }
};

exports.aiBrief = async (req, res, next) => {
  try {
    const o = await buildOverview(req);
    if (!o.perBranch.length) return next(new AppError('Add branches and reports first.', 400));
    const compact = {
      period: o.period,
      kpis: o.kpis,
      branches: o.perBranch.map((b) => ({
        name: b.name, line: b.businessLine, sales: b.sales, variance: b.variance, achievementPct: b.achievement,
        pending: b.pending, litres: b.litres, missingToday: b.missingToday,
      })),
      alerts: o.alerts.map((a) => a.message),
      attendants: o.attendants.slice(0, 8).map((a) => ({ name: a.name, branch: a.branch, shifts: a.shifts, variance: a.variance, shortShifts: a.shortShifts, meterGapLitres: a.meterGapLitres })),
    };
    const response = await complete({
      model: MODELS.SMART,
      maxTokens: 700,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'You are the chief operating analyst for a Nigerian business group (filling stations and building-materials outlets). '
            + 'Write a briefing for the group owner from the JSON data. Use plain text only, no markdown symbols. '
            + 'Structure: one line headline; then 4 to 6 short lines each starting with "- " covering top and weakest branches, cash shortages that need investigation, '
            + 'attendants who are repeatedly short, meter handover gaps (possible unrecorded fuel), reports still awaiting approval or missing, and one or two concrete actions for today. Use ₦ with thousands separators. Be direct and specific, no filler.',
        },
        { role: 'user', content: JSON.stringify(compact) },
      ],
    });
    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return next(new AppError('The AI briefing came back empty. Please try again.', 502));
    res.json({ success: true, data: { brief: text, generatedAt: new Date() } });
  } catch (err) {
    logger.error(`Group AI brief failed: ${err.message}`);
    next(err.statusCode ? err : new AppError('Could not generate the AI briefing right now.', 502));
  }
};

// ── Final approved sales ledger ──────────────────────────────────────
exports.ledger = async (req, res, next) => {
  try {
    const to = req.query.to || todayYmd();
    const from = req.query.from || addDays(to, -6);
    const branches = await visibleBranches(req);
    const q = {
      companyId: req.companyId,
      status: 'approved',
      branchId: { $in: branches.map((b) => b._id) },
      reportDate: { $gte: dayStart(from), $lte: dayStart(to) },
    };
    if (req.query.branchId) q.branchId = branches.find((b) => idEq(b._id, req.query.branchId))?._id || null;
    const entries = await BranchReport.find(q)
      .select('ledgerNumber referenceNumber branchName businessLine department reportDate totals approvals approvedAt preparedByName shift attendantName')
      .sort({ reportDate: 1, branchName: 1, department: 1, 'shift.start': 1 })
      .lean();

    const sum = (f) => entries.reduce((s, r) => s + (r.totals[f] || 0), 0);
    const byBranch = {};
    entries.forEach((r) => {
      byBranch[r.branchName] = byBranch[r.branchName] || { branch: r.branchName, businessLine: r.businessLine, sales: 0, collected: 0, expenses: 0, variance: 0, litres: 0, count: 0 };
      const b = byBranch[r.branchName];
      b.sales += r.totals.expectedSales; b.collected += r.totals.collected; b.expenses += r.totals.expenses;
      b.variance += r.totals.variance; b.litres += r.totals.litres; b.count += 1;
    });

    res.json({
      success: true,
      data: {
        period: { from, to },
        entries,
        byBranch: Object.values(byBranch).sort((a, b) => b.sales - a.sales),
        totals: { sales: sum('expectedSales'), collected: sum('collected'), expenses: sum('expenses'), variance: sum('variance'), litres: sum('litres'), count: entries.length },
      },
    });
  } catch (err) { next(err); }
};

// ── Demo data (for presentations) ─────────────────────────────────────
const DEMO_BRANCHES = [
  {
    name: 'Mega Fuel – Lekki', code: 'MFLK', businessLine: 'filling_station', city: 'Lekki', state: 'Lagos', address: 'Km 18 Lekki-Epe Expressway',
    pumps: 4, perNozzle: [650, 1050], target: 14000000,
    attendants: ['Chinedu Okafor', 'Aisha Bello', 'Samuel Etim', 'Grace Akpan'],
  },
  {
    name: 'Mega Fuel – Ikeja', code: 'MFIK', businessLine: 'filling_station', city: 'Ikeja', state: 'Lagos', address: '45 Obafemi Awolowo Way',
    pumps: 4, perNozzle: [550, 950], target: 12500000,
    attendants: ['Tunde Adeyemi', 'Ngozi Eze', 'Musa Danladi', 'Blessing Okon'],
    leakyAttendant: 'Musa Danladi', meterGapDaysAgo: 3,
  },
  {
    name: 'Mega Fuel – Wuse', code: 'MFAB', businessLine: 'filling_station', city: 'Wuse II', state: 'FCT Abuja', address: 'Aminu Kano Crescent',
    pumps: 3, perNozzle: [500, 900], target: 9500000, silentToday: true,
    attendants: ['Ibrahim Musa', 'Halima Yusuf', 'Peter Ojo', 'Zainab Sani'],
  },
  { name: 'BuildPro – Ajah', code: 'BPAJ', businessLine: 'building_materials', city: 'Ajah', state: 'Lagos', address: 'Abraham Adesanya Roundabout', target: 9000000 },
  { name: 'BuildPro – Port Harcourt', code: 'BPPH', businessLine: 'building_materials', city: 'Port Harcourt', state: 'Rivers', address: 'Ikwerre Road, Rumuokoro', target: 7500000 },
];
const FUEL_PRICES = { PMS: 1000, AGO: 1150, DPK: 1250 };
const DEMO_SHIFTS = [{ name: 'Morning', start: '06:00', end: '14:00' }, { name: 'Afternoon', start: '14:00', end: '22:00' }];
const SHOP_ITEMS = [['Engine Oil 4L', 'pcs', 18500, [8, 25]], ['Engine Oil 1L', 'pcs', 5200, [15, 40]], ['Brake Fluid', 'pcs', 3500, [3, 12]], ['Car Wash', 'service', 3000, [10, 30]]];
const GAS_ITEMS = [['LPG Refill', 'kg', 1250, [250, 600]], ['12.5kg Cylinder (new)', 'pcs', 48000, [0, 3]]];
const BUILD_ITEMS = {
  'Cement & Blocks': [['Dangote Cement 50kg', 'bags', 9800, [180, 420]], ['9" Hollow Blocks', 'pcs', 750, [600, 1800]], ['Sharp Sand (trip)', 'trips', 165000, [1, 4]]],
  'Iron Rods & Steel': [['12mm Iron Rod', 'lengths', 11500, [60, 180]], ['16mm Iron Rod', 'lengths', 19800, [30, 90]], ['Binding Wire', 'rolls', 42000, [2, 8]]],
  'Roofing & Finishing': [['Aluminium Roofing Sheet', 'sheets', 8900, [40, 140]], ['Floor Tiles 60x60', 'cartons', 14500, [20, 70]], ['Emulsion Paint 20L', 'buckets', 38000, [4, 15]]],
  'Plumbing & Electrical': [['PVC Pipe 4"', 'lengths', 7800, [15, 50]], ['2.5mm Cable (roll)', 'rolls', 46000, [2, 9]], ['WC Set', 'pcs', 95000, [0, 4]]],
};
const NAMES = ['Chinedu Okafor', 'Aisha Bello', 'Tunde Adeyemi', 'Ngozi Eze', 'Ibrahim Musa', 'Funke Adebayo', 'Emeka Nwosu', 'Halima Yusuf'];
const SENDERS = ['Adewale Motors', 'Kunle Bakare', 'Chioma Nwankwo', 'Dangote Logistics', 'Femi Ogunleye', 'Uche Transport', 'Bola Ahmed', 'Yetunde Alade', 'GIG Logistics', 'Obinna Eze'];
const BANKS = ['GTBank', 'Access', 'Zenith', 'First Bank', 'UBA', 'Opay', 'Moniepoint', 'Kuda'];

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

exports.loadDemo = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can load demo data.', 403));
    const existing = await Branch.countDocuments({ companyId: req.companyId, demo: true });
    if (existing) return next(new AppError('Demo data is already loaded. Clear it first to reload.', 400));

    const rand = seededRandom(Date.now() % 100000 + 7);
    const between = ([a, b]) => Math.round(a + rand() * (b - a));
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const DAYS = 21;
    const today = todayYmd();

    const nozzlesFor = (spec) => Array.from({ length: spec.pumps || 0 }).flatMap((_, pi) => [1, 2].map((n) => ({
      code: `P${pi + 1}-N${n}`, pump: `Pump ${pi + 1}`, product: pi === spec.pumps - 1 ? 'AGO' : 'PMS',
    })));

    const branches = await Branch.insertMany(DEMO_BRANCHES.map((b) => ({
      companyId: req.companyId, name: b.name, code: b.code, businessLine: b.businessLine, city: b.city, state: b.state,
      address: b.address, dailySalesTarget: b.target, demo: true,
      fuelPrices: b.businessLine === 'filling_station' ? FUEL_PRICES : undefined,
      nozzles: b.businessLine === 'filling_station' ? nozzlesFor(b) : [],
      shifts: DEMO_SHIFTS,
      departments: DEFAULT_BRANCH_DEPARTMENTS[b.businessLine].map((name) => ({ name })),
    })));

    // Approval state by age: older → fully approved; recent → still moving through the chain.
    function applyStatus(doc, daysAgo, submittedAt) {
      const approvals = [{ level: 'branch_manager', status: 'pending' }, { level: 'owner', status: 'pending' }];
      doc.submittedAt = submittedAt;
      doc.trail = [{ action: 'submitted', byName: doc.preparedByName, at: submittedAt }];
      if (daysAgo >= 2 || (daysAgo === 1 && rand() < 0.5)) {
        approvals[0] = { level: 'branch_manager', status: 'approved', byName: 'Branch Manager', at: new Date(submittedAt.getTime() + 3600e3) };
        approvals[1] = { level: 'owner', status: 'approved', byName: req.user.name, at: new Date(submittedAt.getTime() + 18 * 3600e3) };
        doc.status = 'approved';
        doc.approvedAt = approvals[1].at;
        doc.trail.push({ action: 'approved (branch)', byName: 'Branch Manager', at: approvals[0].at },
          { action: 'approved (final)', byName: req.user.name, at: approvals[1].at });
      } else if (daysAgo === 1 || rand() < 0.5) {
        approvals[0] = { level: 'branch_manager', status: 'approved', byName: 'Branch Manager', at: new Date(submittedAt.getTime() + 3600e3) };
        doc.status = 'pending_owner';
        doc.trail.push({ action: 'approved (branch)', byName: 'Branch Manager', at: approvals[0].at });
      } else {
        doc.status = 'pending_branch';
      }
      doc.approvals = approvals;
    }

    const docs = [];
    branches.forEach((branch, bi) => {
      const spec = DEMO_BRANCHES[bi];
      const meter = {};
      branch.nozzles.forEach((n) => { meter[n.code] = between([150000, 900000]); });

      for (let i = DAYS - 1; i >= 0; i -= 1) {
        const date = addDays(today, -i);
        const dateKey = date.replace(/-/g, '');
        const weekendBoost = [0, 6].includes(dayStart(date).getUTCDay()) ? 0.85 : 1;
        if (i === 0 && spec.silentToday) continue;

        branch.departments.forEach((dept) => {
          // ── Forecourt: one sheet per attendant per shift, takings per nozzle ──
          if (dept.name.startsWith('Forecourt')) {
            DEMO_SHIFTS.forEach((shift, si) => {
              if (i === 0 && si > 0) return; // today's afternoon shift is still running
              const half = Math.ceil(branch.nozzles.length / 2);
              const groups = [branch.nozzles.slice(0, half), branch.nozzles.slice(half)];
              groups.forEach((nozzles, gi) => {
                // Attendants rotate shifts week to week, so the same people show up across both shifts.
                const rota = (si * 2 + gi + Math.floor(i / 7) * 2) % spec.attendants.length;
                const attendant = spec.attendants[rota];
                const doc = {
                  companyId: req.companyId, branchId: branch._id, branchName: branch.name, businessLine: branch.businessLine,
                  department: dept.name, reportDate: dayStart(date), demo: true, shift: { ...shift },
                  attendantName: attendant, preparedByName: attendant,
                  referenceNumber: `DSR/${branch.code}/${dateKey}/${shift.name.charAt(0)}${gi + 1}`,
                  pumps: [], items: [], expenses: [], transfers: [],
                };
                let shortfall = rand() < 0.15 ? between([1000, 8000]) : 0;
                if (attendant === spec.leakyAttendant && rand() < 0.6) shortfall = between([40000, 180000]);
                else if (rand() < 0.03) shortfall = between([20000, 70000]);

                nozzles.forEach((n, ni) => {
                  const prevClosing = meter[n.code];
                  let opening = prevClosing;
                  // The planted incident: fuel sold between shifts and never recorded.
                  if (spec.meterGapDaysAgo === i && si === 0 && gi === 0 && ni === 0) opening = prevClosing + 380;
                  const litres = Math.round(between(spec.perNozzle) * weekendBoost * (n.product === 'AGO' ? 0.5 : 1));
                  const pumpTest = rand() < 0.08 ? 10 : 0;
                  const closing = opening + litres + pumpTest;
                  meter[n.code] = closing;
                  const price = FUEL_PRICES[n.product];
                  let due = litres * price - (ni === 0 ? shortfall : 0);
                  due = Math.max(0, due);
                  const pos = Math.round(due * (0.25 + rand() * 0.15) / 100) * 100;
                  const transfer = Math.round(due * (0.25 + rand() * 0.15) / 100) * 100;
                  const cash = Math.max(0, due - pos - transfer);
                  doc.pumps.push({
                    pump: n.pump, nozzle: n.code, product: n.product, openingMeter: opening, closingMeter: closing, pumpTest,
                    pricePerLitre: price, cash, pos, transfer, prevClosing, meterGap: opening - prevClosing,
                  });
                  // Itemise the transfers so they can be matched to bank alerts.
                  let left = transfer;
                  const parts = transfer > 300000 ? 3 : transfer > 100000 ? 2 : 1;
                  for (let k = 0; k < parts && left > 0; k += 1) {
                    const amt = k === parts - 1 ? left : Math.round((transfer / parts) / 100) * 100;
                    left -= amt;
                    doc.transfers.push({
                      sender: pick(SENDERS), bank: pick(BANKS), nozzle: n.code, amount: amt,
                      reference: `${pick(['NIP', 'TRF', 'FT'])}${Math.floor(rand() * 1e10).toString().padStart(10, '0')}`,
                    });
                  }
                });
                if (si === 0 && gi === 0) doc.expenses.push({ description: 'Generator diesel', amount: between([18000, 45000]) });
                // Expenses come out of the cash drawer.
                if (doc.expenses.length) doc.pumps[0].cash = Math.max(0, doc.pumps[0].cash - doc.expenses[0].amount);
                const startH = Number(shift.end.slice(0, 2));
                applyStatus(doc, i, new Date(dayStart(date).getTime() + (startH - 1) * 3600e3 + 20 * 60e3));
                docs.push(doc);
              });
            });
            return;
          }

          // ── Shop, gas and building-materials departments: one daily sheet ──
          if (i === 0 && rand() < 0.25) return; // some departments haven't reported yet today
          const doc = {
            companyId: req.companyId, branchId: branch._id, branchName: branch.name, businessLine: branch.businessLine,
            department: dept.name, reportDate: dayStart(date), demo: true,
            referenceNumber: `DSR/${branch.code}/${dateKey}/${docs.length + 1}`,
            preparedByName: pick(NAMES), pumps: [], items: [], expenses: [],
          };
          const catalogue = dept.name.startsWith('Lubricants') ? SHOP_ITEMS : dept.name.startsWith('Gas') ? GAS_ITEMS : BUILD_ITEMS[dept.name];
          catalogue.forEach(([description, unit, unitPrice, range]) => {
            const quantity = Math.round(between(range) * weekendBoost);
            if (quantity > 0) doc.items.push({ description, unit, unitPrice, quantity });
          });
          if (rand() < 0.3) doc.expenses.push({ description: pick(['Loading/offloading', 'Transport', 'Security levy']), amount: between([5000, 25000]) });
          const expected = doc.items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
          let net = expected - doc.expenses.reduce((s, e) => s + e.amount, 0);
          let shortfall = rand() < 0.15 ? between([2000, 15000]) : 0;
          if (rand() < 0.04) shortfall = between([60000, 150000]);
          net -= shortfall;
          const cash = Math.round(net * (0.3 + rand() * 0.15));
          const pos = Math.round(net * (0.25 + rand() * 0.1));
          doc.collections = { cash, pos, transfer: Math.max(0, net - cash - pos), credit: 0 };
          applyStatus(doc, i, new Date(dayStart(date).getTime() + 20 * 3600 * 1000));
          docs.push(doc);
        });
      }
    });

    // One report sent back for correction so the rejection flow shows up too.
    const toReject = docs.find((d) => d.status === 'pending_branch') || docs.find((d) => d.status === 'pending_owner');
    if (toReject) {
      toReject.status = 'rejected';
      toReject.approvals[0] = { level: 'branch_manager', status: 'rejected', byName: 'Branch Manager', comment: 'POS total does not match the terminal settlement slip — recount and resubmit.', at: new Date() };
      toReject.trail.push({ action: 'rejected', byName: 'Branch Manager', comment: toReject.approvals[0].comment });
    }

    // Ledger numbers in date order, continuing any real ones already issued.
    const year = new Date().getFullYear();
    let n = await BranchReport.countDocuments({ companyId: req.companyId, ledgerNumber: { $regex: `^SL/${year}/` } });
    docs.filter((d) => d.status === 'approved')
      .sort((a, b) => (a.reportDate - b.reportDate) || String(a.shift?.start || '').localeCompare(String(b.shift?.start || '')))
      .forEach((d) => { n += 1; d.ledgerNumber = `SL/${year}/${String(n).padStart(5, '0')}`; });

    const models = docs.map((d) => new BranchReport(d));
    await Promise.all(models.map((m) => m.validate())); // runs computeTotals
    await BranchReport.insertMany(models);

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.demo_load', description: `${branches.length} branches, ${models.length} reports`, ip: req.ip });
    res.status(201).json({ success: true, data: { branches: branches.length, reports: models.length } });
  } catch (err) { next(err); }
};

exports.clearDemo = async (req, res, next) => {
  try {
    if (!isGroupLevel(req.user)) return next(new AppError('Only the owner can clear demo data.', 403));
    const r1 = await BranchReport.deleteMany({ companyId: req.companyId, demo: true });
    const r2 = await Branch.deleteMany({ companyId: req.companyId, demo: true });
    res.json({ success: true, data: { reports: r1.deletedCount, branches: r2.deletedCount } });
  } catch (err) { next(err); }
};
