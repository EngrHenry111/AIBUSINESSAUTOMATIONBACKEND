'use strict';

const StaffSalary = require('../models/StaffSalary');
const Payroll = require('../models/Payroll');
const Expense = require('../models/Expense');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Nigerian payroll math: PAYE (tax) and PenCom (pension) are both computed as
// a percentage of gross; "other" (loan repayments, uniform deductions, etc.)
// is a flat amount set per-staff, not a rate.
function calcDeductions(staff) {
  const gross = Number(staff.grossSalary) || 0;
  const tax = Math.round((gross * (Number(staff.taxRate ?? 7.5) / 100)) * 100) / 100;
  const pension = Math.round((gross * (Number(staff.pensionRate ?? 8) / 100)) * 100) / 100;
  const other = Number(staff.otherDeduction) || 0;
  const net = Math.round((gross - tax - pension - other) * 100) / 100;
  return { tax, pension, other, net };
}

function staffWithCalc(staff) {
  const s = staff.toObject ? staff.toObject() : staff;
  const { tax, pension, other, net } = calcDeductions(s);
  return { ...s, deductions: { tax, pension, other }, netSalary: net };
}

// ── GET /payroll/staff ────────────────────────────────────────────────
exports.getStaff = async (req, res, next) => {
  try {
    const staff = await StaffSalary.find({ companyId: req.companyId, isActive: true }).sort({ name: 1 });
    res.status(200).json({ success: true, data: staff.map(staffWithCalc) });
  } catch (err) { next(err); }
};

// ── POST /payroll/staff ───────────────────────────────────────────────
exports.addStaff = async (req, res, next) => {
  try {
    const { name, email, role, department, grossSalary, bankName, bankCode, accountNumber, accountName, taxRate, pensionRate, otherDeduction, startDate } = req.body;
    if (!name?.trim()) return next(new AppError('Staff name is required.', 400));
    if (!(Number(grossSalary) > 0)) return next(new AppError('Gross salary must be greater than zero.', 400));

    const staff = await StaffSalary.create({
      companyId: req.companyId,
      name: name.trim(),
      email: email?.trim(),
      role: role?.trim(),
      department: department?.trim(),
      grossSalary: Number(grossSalary),
      bankName, bankCode, accountNumber, accountName,
      taxRate: taxRate != null ? Number(taxRate) : 7.5,
      pensionRate: pensionRate != null ? Number(pensionRate) : 8,
      otherDeduction: otherDeduction != null ? Number(otherDeduction) : 0,
      startDate: startDate || new Date(),
    });

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payroll.staff_add', description: `${staff.name} — ${naira(staff.grossSalary)}/month`, ip: req.ip });
    res.status(201).json({ success: true, data: staffWithCalc(staff) });
  } catch (err) { next(err); }
};

// ── PUT /payroll/staff/:id ────────────────────────────────────────────
exports.updateStaff = async (req, res, next) => {
  try {
    const allowed = ['name', 'email', 'role', 'department', 'grossSalary', 'bankName', 'bankCode', 'accountNumber', 'accountName', 'taxRate', 'pensionRate', 'otherDeduction', 'startDate', 'isActive'];
    const set = {};
    for (const key of allowed) if (req.body[key] !== undefined) set[key] = req.body[key];

    const staff = await StaffSalary.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { $set: set },
      { new: true, runValidators: true }
    );
    if (!staff) return next(new AppError('Staff record not found.', 404));

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payroll.staff_update', description: staff.name, ip: req.ip });
    res.status(200).json({ success: true, data: staffWithCalc(staff) });
  } catch (err) { next(err); }
};

// ── DELETE /payroll/staff/:id ─────────────────────────────────────────
exports.removeStaff = async (req, res, next) => {
  try {
    const staff = await StaffSalary.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!staff) return next(new AppError('Staff record not found.', 404));

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payroll.staff_remove', description: staff.name, ip: req.ip });
    res.status(200).json({ success: true, message: 'Staff member removed from payroll.' });
  } catch (err) { next(err); }
};

// ── POST /payroll/generate ────────────────────────────────────────────
exports.generatePayroll = async (req, res, next) => {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    if (!(month >= 1 && month <= 12)) return next(new AppError('Month must be between 1 and 12.', 400));
    if (!(year >= 2000 && year <= 2100)) return next(new AppError('Enter a valid year.', 400));

    const existing = await Payroll.findOne({ companyId: req.companyId, month, year });
    if (existing) {
      return next(new AppError(`Payroll for ${MONTH_NAMES[month - 1]} ${year} already exists.`, 409));
    }

    const staff = await StaffSalary.find({ companyId: req.companyId, isActive: true });
    if (!staff.length) return next(new AppError('No active staff to generate payroll for. Add staff first.', 400));

    const employees = staff.map((s) => {
      const { tax, pension, other, net } = calcDeductions(s);
      return {
        userId: s.userId || undefined,
        staffId: s._id,
        name: s.name,
        email: s.email,
        role: s.role,
        grossSalary: s.grossSalary,
        deductions: { tax, pension, other },
        netSalary: net,
        bankName: s.bankName,
        accountNumber: s.accountNumber,
        accountName: s.accountName,
        status: 'pending',
      };
    });

    const totalGross = employees.reduce((sum, e) => sum + e.grossSalary, 0);
    const totalDeductions = employees.reduce((sum, e) => sum + e.deductions.tax + e.deductions.pension + e.deductions.other, 0);
    const totalNet = employees.reduce((sum, e) => sum + e.netSalary, 0);

    const payroll = await Payroll.create({
      companyId: req.companyId, month, year, status: 'draft',
      totalGross, totalDeductions, totalNet,
      createdBy: req.user._id, employees,
    });

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payroll.generate', description: `${MONTH_NAMES[month - 1]} ${year} — ${employees.length} staff, ${naira(totalNet)} net`, ip: req.ip });
    logger.warn(`Payroll generated: company ${req.companyId}, ${MONTH_NAMES[month - 1]} ${year}, ${employees.length} staff, net ${totalNet}`);
    res.status(201).json({ success: true, data: payroll });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('Payroll for this period already exists.', 409));
    next(err);
  }
};

// ── GET /payroll ──────────────────────────────────────────────────────
exports.getPayrolls = async (req, res, next) => {
  try {
    const { year, status } = req.query;
    const q = { companyId: req.companyId };
    if (year) q.year = Number(year);
    if (status) q.status = status;

    const payrolls = await Payroll.find(q).sort({ year: -1, month: -1 }).lean();
    const data = payrolls.map((p) => ({
      _id: p._id, month: p.month, year: p.year, status: p.status,
      staffCount: p.employees.length, totalGross: p.totalGross,
      totalDeductions: p.totalDeductions, totalNet: p.totalNet,
      paidAt: p.paidAt, createdAt: p.createdAt,
    }));
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

// ── GET /payroll/:id ──────────────────────────────────────────────────
exports.getPayroll = async (req, res, next) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!payroll) return next(new AppError('Payroll not found.', 404));
    res.status(200).json({ success: true, data: payroll });
  } catch (err) { next(err); }
};

// Records the one expense for a payroll run the moment it's fully paid —
// shared by markAsPaid (whole payroll at once) and markEmployeePaid (when
// marking the last remaining employee completes the run), so there is
// always exactly one "Salary Payment" expense per payroll, never one per
// employee, regardless of which path finished it.
async function recordPayrollExpense(payroll, req) {
  const monthLabel = `${MONTH_NAMES[payroll.month - 1]} ${payroll.year}`;
  const expense = await Expense.create({
    companyId: req.companyId,
    title: `Salary Payment - ${monthLabel}`,
    category: 'salaries',
    amount: payroll.totalNet,
    currency: payroll.currency || 'NGN',
    date: new Date(),
    paymentMethod: 'bank_transfer',
    status: 'approved',
    approvedBy: req.user._id,
    createdBy: req.user._id,
    description: `Auto-recorded from payroll — ${payroll.employees.length} staff`,
  });
  cache.del(`dashboard_${req.companyId}`);
  logger.warn(`Payroll marked paid: company ${req.companyId}, ${monthLabel}, expense ${expense._id} recorded`);
}

// ── PATCH /payroll/:id/mark-paid ──────────────────────────────────────
// Marks the ENTIRE payroll (every employee) as paid in one action.
exports.markAsPaid = async (req, res, next) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!payroll) return next(new AppError('Payroll not found.', 404));
    if (payroll.status === 'paid') return next(new AppError('This payroll is already marked as paid.', 400));

    const now = new Date();
    payroll.status = 'paid';
    payroll.paidAt = now;
    payroll.employees.forEach((e) => { e.status = 'paid'; e.paidAt = now; });
    await payroll.save();

    await recordPayrollExpense(payroll, req);
    const monthLabel = `${MONTH_NAMES[payroll.month - 1]} ${payroll.year}`;
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payroll.mark_paid', description: `${monthLabel} — ${naira(payroll.totalNet)}`, ip: req.ip });

    res.status(200).json({ success: true, data: payroll });
  } catch (err) { next(err); }
};

// ── PATCH /payroll/:id/employees/:employeeId/mark-paid ─────────────────
// Marks ONE employee as paid — for businesses that pay staff on different
// days rather than all at once. The payroll moves to 'processing' once at
// least one (but not all) employees are paid, and to 'paid' — recording the
// same auto-expense markAsPaid would have — the moment the last one is.
exports.markEmployeePaid = async (req, res, next) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!payroll) return next(new AppError('Payroll not found.', 404));

    const employee = payroll.employees.id(req.params.employeeId);
    if (!employee) return next(new AppError('Employee not found on this payroll.', 404));
    if (employee.status === 'paid') return next(new AppError('This employee is already marked as paid.', 400));

    employee.status = 'paid';
    employee.paidAt = new Date();

    const allPaid = payroll.employees.every((e) => e.status === 'paid');
    if (allPaid) {
      payroll.status = 'paid';
      payroll.paidAt = new Date();
    } else if (payroll.status === 'draft') {
      payroll.status = 'processing';
    }
    await payroll.save();

    if (allPaid) await recordPayrollExpense(payroll, req);
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payroll.employee_paid', description: `${employee.name} — ${naira(employee.netSalary)}`, ip: req.ip });

    res.status(200).json({ success: true, data: payroll });
  } catch (err) { next(err); }
};

// ── GET /payroll/:id/payslip/:employeeId ──────────────────────────────
exports.generatePayslip = async (req, res, next) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!payroll) return next(new AppError('Payroll not found.', 404));

    const employee = payroll.employees.id(req.params.employeeId);
    if (!employee) return next(new AppError('Employee not found on this payroll.', 404));

    const company = await Company.findById(req.companyId).select('companyName logo profile website');
    const profile = company?.profile || {};
    const monthLabel = `${MONTH_NAMES[payroll.month - 1]} ${payroll.year}`;
    const taxPct = employee.grossSalary ? ((employee.deductions.tax / employee.grossSalary) * 100).toFixed(1) : '0.0';
    const pensionPct = employee.grossSalary ? ((employee.deductions.pension / employee.grossSalary) * 100).toFixed(1) : '0.0';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>Payslip — ${esc(employee.name)} — ${esc(monthLabel)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; gap: 20px; border-bottom: 3px solid #6366f1; padding-bottom: 20px; }
  .brand-row { display: flex; align-items: center; gap: 12px; }
  .brand-logo { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; }
  .brand { font-size: 20px; font-weight: 800; color: #6366f1; }
  .brand-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
  .payslip-title { font-size: 26px; font-weight: 700; color: #1e293b; text-align: right; }
  .payslip-period { font-size: 14px; color: #64748b; text-align: right; margin-top: 4px; }
  .status-badge { display: inline-block; margin-top: 8px; padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase;
    background: ${employee.status === 'paid' ? '#dcfce7' : '#fef3c7'}; color: ${employee.status === 'paid' ? '#166534' : '#92400e'}; }
  .info-section { display: flex; justify-content: space-between; margin-bottom: 28px; gap: 20px; }
  .info-block h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 8px; }
  .info-block p { font-size: 14px; color: #334155; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #f8fafc; padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; }
  td { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  .amt { text-align: right; }
  .deduction { color: #dc2626; }
  .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #6366f1; border-bottom: none; color: #6366f1; }
  .rules-note { margin-top: 24px; padding: 14px 18px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #64748b; line-height: 1.7; }
  .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="brand-row">
      ${company?.logo ? `<img class="brand-logo" src="${esc(company.logo)}" alt="${esc(company?.companyName)}"/>` : ''}
      <div>
        <div class="brand">${esc(company?.companyName || 'BizlyAI')}</div>
        ${profile.address ? `<div class="brand-sub">${esc(profile.address)}</div>` : ''}
      </div>
    </div>
  </div>
  <div>
    <div class="payslip-title">PAYSLIP</div>
    <div class="payslip-period">${esc(monthLabel)}</div>
    <div style="text-align:right"><span class="status-badge">${employee.status}</span></div>
  </div>
</div>

<div class="info-section">
  <div class="info-block">
    <h4>Employee</h4>
    <p><strong>${esc(employee.name)}</strong></p>
    ${employee.role ? `<p>${esc(employee.role)}</p>` : ''}
    ${employee.email ? `<p>${esc(employee.email)}</p>` : ''}
  </div>
  <div class="info-block" style="text-align:right">
    <h4>Payment Details</h4>
    <p>${employee.bankName ? esc(employee.bankName) : '—'}</p>
    <p>${employee.accountNumber ? esc(employee.accountNumber) : '—'}</p>
    ${employee.paidAt ? `<p>Paid: ${new Date(employee.paidAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>` : ''}
  </div>
</div>

<table>
  <thead><tr><th>Description</th><th class="amt">Amount</th></tr></thead>
  <tbody>
    <tr><td>Gross Salary</td><td class="amt">${naira(employee.grossSalary)}</td></tr>
    <tr><td class="deduction">PAYE Tax (${taxPct}%)</td><td class="amt deduction">-${naira(employee.deductions.tax)}</td></tr>
    <tr><td class="deduction">Pension (${pensionPct}%)</td><td class="amt deduction">-${naira(employee.deductions.pension)}</td></tr>
    ${employee.deductions.other ? `<tr><td class="deduction">Other Deductions</td><td class="amt deduction">-${naira(employee.deductions.other)}</td></tr>` : ''}
    <tr class="total-row"><td>Net Salary</td><td class="amt">${naira(employee.netSalary)}</td></tr>
  </tbody>
</table>

<div class="rules-note">
  Statutory rates applied per Nigerian payroll regulations: PAYE tax and Pension (PenCom) are calculated
  as a percentage of gross salary; National Housing Fund (NHF, 2.5%) is optional and only applied where
  configured under "Other Deductions."
</div>

<div class="footer">
  Generated by BizlyAI · ${new Date().toLocaleDateString()}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${employee.name.replace(/\s+/g, '-')}-${payroll.month}-${payroll.year}.html"`);
    res.send(html);
  } catch (err) { next(err); }
};
