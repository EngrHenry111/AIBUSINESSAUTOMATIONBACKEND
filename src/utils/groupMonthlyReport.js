'use strict';

// Monthly group report — one branded PDF per month for the owner, their
// accountant or board: sales and profit by branch, daily sales chart, who
// was short, meter gaps, credit customers owed, stock losses and POS
// settlement gaps. Pure pdfkit (no headless Chrome — see invoicePdf.js).
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const Company = require('../models/Company');
const User = require('../models/User');
const Branch = require('../models/Branch');
const BranchReport = require('../models/BranchReport');
const GroupStockItem = require('../models/GroupStockItem');
const GroupStockMove = require('../models/GroupStockMove');
const GroupCreditCustomer = require('../models/GroupCreditCustomer');
const GroupPosSettlement = require('../models/GroupPosSettlement');
const emailService = require('../services/emailService');
const { attendantBreakdown } = require('./attendantBreakdown');
const { agingFor } = require('./groupCredit');
const logger = require('./logger');

const LIVE = { status: { $nin: ['draft', 'rejected'] } };
const dayStart = (s) => new Date(`${s}T00:00:00.000Z`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first, last: `${ym}-${String(lastDay).padStart(2, '0')}`, days: lastDay };
}
const prevMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
};

async function buildMonthlyData(rawCompanyId, ym) {
  const companyId = new mongoose.Types.ObjectId(String(rawCompanyId));
  const { first, last, days } = monthBounds(ym);
  const company = await Company.findById(companyId).select('companyName profile logo');
  const branches = await Branch.find({ companyId }).sort({ name: 1 }).lean();
  const ids = branches.map((b) => b._id);
  const range = { $gte: dayStart(first), $lte: dayStart(last) };

  const [reports, prevAgg, countMoves, lowStock, creditCustomers, settlements] = await Promise.all([
    BranchReport.find({ companyId, branchId: { $in: ids }, reportDate: range, ...LIVE })
      .select('branchId branchName reportDate status totals attendantName pumps expenses collections.credit creditSales').lean(),
    BranchReport.aggregate([
      { $match: { companyId, branchId: { $in: ids }, ...LIVE, reportDate: { $gte: dayStart(`${prevMonth(ym)}-01`), $lte: dayStart(monthBounds(prevMonth(ym)).last) } } },
      { $group: { _id: null, sales: { $sum: '$totals.expectedSales' }, net: { $sum: '$totals.netProfit' } } },
    ]),
    GroupStockMove.find({ companyId, branchId: { $in: ids }, type: 'count', date: { $gte: dayStart(first), $lte: new Date(`${last}T23:59:59.999Z`) } }).lean(),
    GroupStockItem.countDocuments({ companyId, active: true, reorderLevel: { $gt: 0 }, $expr: { $lte: ['$quantity', '$reorderLevel'] } }),
    GroupCreditCustomer.find({ companyId, active: true }).select('name balance creditLimit').lean(),
    GroupPosSettlement.find({ companyId, branchId: { $in: ids }, date: range }).lean(),
  ]);

  const sum = (arr, f) => arr.reduce((s, r) => s + (f(r) || 0), 0);
  const totals = {
    sales: sum(reports, (r) => r.totals.expectedSales),
    approved: sum(reports.filter((r) => r.status === 'approved'), (r) => r.totals.expectedSales),
    cost: sum(reports, (r) => r.totals.cost),
    grossProfit: sum(reports, (r) => r.totals.grossProfit ?? r.totals.expectedSales),
    expenses: sum(reports, (r) => r.totals.expenses),
    netProfit: sum(reports, (r) => r.totals.netProfit ?? ((r.totals.expectedSales || 0) - (r.totals.expenses || 0))),
    litres: sum(reports, (r) => r.totals.litres),
    shortages: sum(reports.filter((r) => r.totals.variance < 0), (r) => r.totals.variance),
    meterGapLitres: sum(reports, (r) => r.totals.meterGapLitres),
    reports: reports.length,
    posRecorded: sum(reports, (r) => r.collections?.pos),
  };
  totals.margin = totals.sales ? round2((totals.grossProfit / totals.sales) * 100) : 0;
  const prev = prevAgg[0] || { sales: 0, net: 0 };

  const branchRows = branches.map((b) => {
    const rs = reports.filter((r) => String(r.branchId) === String(b._id));
    const s = sum(rs, (r) => r.totals.expectedSales);
    const gp = sum(rs, (r) => r.totals.grossProfit ?? r.totals.expectedSales);
    return {
      name: b.name,
      sales: s,
      grossProfit: gp,
      margin: s ? round2((gp / s) * 100) : 0,
      netProfit: sum(rs, (r) => r.totals.netProfit ?? ((r.totals.expectedSales || 0) - (r.totals.expenses || 0))),
      shortages: sum(rs.filter((r) => r.totals.variance < 0), (r) => r.totals.variance),
      achievement: b.dailySalesTarget ? Math.round((s / (b.dailySalesTarget * days)) * 100) : null,
      litres: sum(rs, (r) => r.totals.litres),
    };
  }).filter((b) => b.sales || b.shortages).sort((a, b) => b.sales - a.sales);

  const daily = Array.from({ length: days }, (_, i) => {
    const d = `${ym}-${String(i + 1).padStart(2, '0')}`;
    return { day: i + 1, sales: sum(reports.filter((r) => r.reportDate.toISOString().slice(0, 10) === d), (r) => r.totals.expectedSales) };
  });

  const people = {};
  reports.forEach((r) => attendantBreakdown(r).forEach((a) => {
    const k = `${a.name}|${r.branchName}`;
    people[k] = people[k] || { name: a.name, branch: r.branchName, shifts: 0, shortShifts: 0, variance: 0 };
    people[k].shifts += 1;
    people[k].variance += a.variance;
    if (a.variance <= -5000) people[k].shortShifts += 1;
  }));
  const attendants = Object.values(people).filter((p) => p.variance <= -1000).sort((a, b) => a.variance - b.variance).slice(0, 10);

  const aging = await agingFor(creditCustomers.map((c) => c._id));
  const credit = creditCustomers.map((c) => ({ name: c.name, ...aging[String(c._id)] })).filter((c) => c.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding);

  const settled = sum(settlements, (s) => s.settledAmount + (s.charges || 0));

  return {
    company: company?.companyName || 'Company',
    ym,
    monthLabel: dayStart(first).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    totals,
    prev,
    branches: branchRows,
    daily,
    attendants,
    credit: {
      outstanding: sum(credit, (c) => c.outstanding),
      overdue: sum(credit, (c) => c.overdue),
      d90plus: sum(credit, (c) => c.aging.d90plus),
      top: credit.slice(0, 8),
    },
    stock: {
      countLossValue: sum(countMoves.filter((m) => m.value < 0), (m) => m.value),
      countGainValue: sum(countMoves.filter((m) => m.value > 0), (m) => m.value),
      lowStock,
    },
    pos: { recorded: totals.posRecorded, settled, gap: round2(settled - totals.posRecorded) },
  };
}

// ── PDF rendering ──────────────────────────────────────────────────────
const BRAND = '#4f46e5';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const RED = '#dc2626';
const GREEN = '#059669';
// Helvetica has no ₦ glyph — amounts use NGN.
const money = (n) => `NGN ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const short = (n) => {
  const a = Math.abs(Number(n) || 0);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}NGN ${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}NGN ${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}NGN ${(a / 1e3).toFixed(0)}K`;
  return `${sign}NGN ${Math.round(a)}`;
};
const clean = (s) => String(s ?? '').replace(/₦/g, 'NGN ').replace(/[–—]/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');
const pctChange = (now, before) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% vs last month` : '');

function renderMonthlyPdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${d.company} - ${d.monthLabel} report`, Author: d.company } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const heading = (t) => {
      ensure(60);
      doc.moveDown(0.8).fillColor(INK).font('Helvetica-Bold').fontSize(13).text(clean(t), L);
      doc.moveTo(L, doc.y + 3).lineTo(L + W, doc.y + 3).strokeColor(LINE).lineWidth(1).stroke();
      doc.moveDown(0.6);
    };
    // Simple table: cols = [{ label, width (fraction), align, color? }], rows = arrays of strings
    const table = (cols, rows, opts = {}) => {
      const rowH = 18;
      const xs = [];
      let x = L;
      cols.forEach((c) => { xs.push(x); x += c.width * W; });
      ensure(rowH * 2);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
      let y = doc.y;
      cols.forEach((c, i) => doc.text(clean(c.label).toUpperCase(), xs[i] + 4, y + 4, { width: c.width * W - 8, align: c.align || 'left' }));
      y += rowH;
      doc.moveTo(L, y).lineTo(L + W, y).strokeColor(LINE).stroke();
      rows.forEach((row, ri) => {
        if (y + rowH > bottom()) { doc.addPage(); y = doc.y; }
        const isTotal = opts.totalRow && ri === rows.length - 1;
        if (!isTotal && ri % 2 === 1) doc.rect(L, y, W, rowH).fill('#f8fafc');
        doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        row.forEach((cell, i) => {
          const col = cols[i];
          const color = typeof col.color === 'function' ? col.color(cell, ri) : INK;
          doc.fillColor(color).text(clean(cell), xs[i] + 4, y + 5, { width: col.width * W - 8, align: col.align || 'left', lineBreak: false, ellipsis: true });
        });
        y += rowH;
        if (isTotal) doc.moveTo(L, y - rowH).lineTo(L + W, y - rowH).strokeColor(INK).lineWidth(0.8).stroke();
      });
      doc.y = y + 6;
      doc.x = L;
    };

    // Header band
    doc.rect(0, 0, doc.page.width, 92).fill(BRAND);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(clean(d.company), L, 28, { width: W });
    doc.font('Helvetica').fontSize(11).fillColor('#e0e7ff').text(`Monthly Group Report  ·  ${d.monthLabel}`, L, 54, { width: W });
    doc.fontSize(8).text(`Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`, L, 70, { width: W, align: 'right' });
    doc.y = 110;

    // KPI tiles
    const t = d.totals;
    const tiles = [
      ['Total sales', short(t.sales), pctChange(t.sales, d.prev.sales)],
      ['Gross profit', short(t.grossProfit), `${t.margin}% margin`],
      ['Net profit', short(t.netProfit), `after ${short(t.expenses)} expenses`],
      ['Cash shortages', short(t.shortages), `${Math.round(t.meterGapLitres).toLocaleString()} L meter gaps`],
      ['Fuel sold', `${Math.round(t.litres).toLocaleString()} L`, `${t.reports} reports`],
      ['Credit owed to you', short(d.credit.outstanding), `${short(d.credit.overdue)} overdue`],
    ];
    const tileW = (W - 20) / 3;
    const tileTop = doc.y; // pdfkit moves doc.y on every text call — anchor the grid
    tiles.forEach(([label, value, sub], i) => {
      const x = L + (i % 3) * (tileW + 10);
      const y = tileTop + Math.floor(i / 3) * 62;
      doc.roundedRect(x, y, tileW, 54, 6).fillAndStroke('#f8fafc', LINE);
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label.toUpperCase(), x + 10, y + 8, { width: tileW - 20 });
      const bad = label === 'Cash shortages' && t.shortages < -1000;
      doc.fillColor(bad ? RED : INK).font('Helvetica-Bold').fontSize(14).text(clean(value), x + 10, y + 20, { width: tileW - 20 });
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(clean(sub), x + 10, y + 39, { width: tileW - 20 });
    });
    doc.y = tileTop + 2 * 62 + 2;
    doc.x = L;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text('Includes every submitted report (approved and awaiting approval); reports sent back for correction are excluded. Profit uses the cost prices recorded at the time of each sale.', L, doc.y, { width: W });

    // Daily sales chart
    heading('Daily sales');
    const chartH = 90;
    ensure(chartH + 30);
    const top = doc.y;
    const max = Math.max(1, ...d.daily.map((x) => x.sales));
    const barW = W / d.daily.length;
    d.daily.forEach((x, i) => {
      const h = (x.sales / max) * chartH;
      doc.rect(L + i * barW + 1.5, top + chartH - h, Math.max(1, barW - 3), h).fill(x.sales ? BRAND : LINE);
      if (i % 5 === 0 || i === d.daily.length - 1) doc.fillColor(MUTED).fontSize(7).text(String(x.day), L + i * barW, top + chartH + 3, { width: barW, align: 'center' });
    });
    doc.fillColor(MUTED).fontSize(7).text(`Peak ${short(max)}`, L, top - 2, { width: W, align: 'right' });
    doc.y = top + chartH + 18;
    doc.x = L;

    // Branches
    heading('Branch performance');
    if (!d.branches.length) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('No branch sales recorded this month.');
    else {
      const rows = d.branches.map((b) => [b.name, money(b.sales), money(b.grossProfit), `${b.margin}%`, money(b.netProfit), b.shortages < -1000 ? money(b.shortages) : '-', b.achievement === null ? '-' : `${b.achievement}%`]);
      rows.push(['Total', money(t.sales), money(t.grossProfit), `${t.margin}%`, money(t.netProfit), t.shortages < -1000 ? money(t.shortages) : '-', '']);
      table([
        { label: 'Branch', width: 0.20 }, { label: 'Sales', width: 0.15, align: 'right' }, { label: 'Gross profit', width: 0.15, align: 'right' },
        { label: 'Margin', width: 0.10, align: 'right' }, { label: 'Net profit', width: 0.15, align: 'right' },
        { label: 'Shortages', width: 0.15, align: 'right', color: (c) => (c !== '-' ? RED : INK) }, { label: 'Target', width: 0.10, align: 'right' },
      ], rows, { totalRow: true });
    }

    // People
    heading('Attendants and staff who came up short');
    if (!d.attendants.length) doc.font('Helvetica').fontSize(9).fillColor(GREEN).text('No staff shortages this month.');
    else {
      table([
        { label: 'Name', width: 0.3 }, { label: 'Branch', width: 0.3 }, { label: 'Short shifts', width: 0.18, align: 'right' },
        { label: 'Net short', width: 0.22, align: 'right', color: () => RED },
      ], d.attendants.map((a) => [a.name, a.branch, `${a.shortShifts} of ${a.shifts}`, money(a.variance)]));
    }

    // Credit
    heading('Credit customers (money owed to you)');
    if (!d.credit.top.length) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('No outstanding credit.');
    else {
      table([
        { label: 'Customer', width: 0.34 }, { label: 'Owes', width: 0.18, align: 'right' }, { label: 'Overdue', width: 0.18, align: 'right', color: (c) => (c !== money(0) ? RED : INK) },
        { label: '90+ days', width: 0.15, align: 'right' }, { label: 'Oldest', width: 0.15, align: 'right' },
      ], d.credit.top.map((c) => [c.name, money(c.outstanding), money(c.overdue), money(c.aging.d90plus), c.oldestOverdueDays ? `${c.oldestOverdueDays} days` : '-']));
    }

    // Controls
    heading('Stock and POS controls');
    table([{ label: 'Check', width: 0.55 }, { label: 'Result', width: 0.45, align: 'right' }], [
      ['Stock count losses (value)', d.stock.countLossValue ? money(d.stock.countLossValue) : 'None'],
      ['Stock count surplus (value)', d.stock.countGainValue ? money(d.stock.countGainValue) : 'None'],
      ['Items at or below reorder level (now)', String(d.stock.lowStock)],
      ['POS recorded on reports', money(d.pos.recorded)],
      ['POS settled by banks (incl. charges)', money(d.pos.settled)],
      ['POS difference', d.pos.recorded ? money(d.pos.gap) : '-'],
    ]);

    doc.end();
  });
}

async function monthlyPdfBuffer(companyId, ym) {
  const data = await buildMonthlyData(companyId, ym);
  return { data, pdf: await renderMonthlyPdf(data) };
}

/** Email last month's report to the owner(s) and summary recipients. */
async function emailMonthlyReport(companyId, ym) {
  const company = await Company.findById(companyId).select('companyName groupDigest');
  const owners = await User.find({ companyId, role: 'company_owner', status: 'active' }).select('email');
  const to = [...new Set([
    ...owners.map((o) => o.email),
    ...(company.groupDigest?.recipients || []).map((r) => r.email),
  ].filter(Boolean).map((e) => e.toLowerCase()))];
  if (!to.length) return { sent: false, reason: 'No email recipients.' };
  const { data, pdf } = await monthlyPdfBuffer(companyId, ym);
  await emailService.sendEmail({
    to,
    subject: `📈 ${data.company}: ${data.monthLabel} report (${short(data.totals.sales).replace('NGN ', '₦')} sales)`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6">Your monthly group report for <strong>${data.monthLabel}</strong> is attached.<br>
      Sales ${money(data.totals.sales).replace('NGN ', '₦')} · Net profit ${money(data.totals.netProfit).replace('NGN ', '₦')} · Shortages ${money(data.totals.shortages).replace('NGN ', '₦')}</div>`,
    attachments: [{ filename: `${data.company.replace(/[^\w]+/g, '-')}-${ym}-report.pdf`, content: pdf }],
  });
  logger.info(`Monthly report ${ym} emailed for ${data.company} to ${to.length} recipient(s)`);
  return { sent: true, to };
}

module.exports = { buildMonthlyData, renderMonthlyPdf, monthlyPdfBuffer, emailMonthlyReport, prevMonth };
