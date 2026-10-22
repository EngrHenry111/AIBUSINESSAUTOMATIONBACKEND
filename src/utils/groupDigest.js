'use strict';

// Nightly group summary — one WhatsApp/email message to the owner with the
// whole day across every branch: sales vs yesterday and last week, branch
// ranking against target, who was short (by name and nozzle), meter gaps,
// missing reports and approvals waiting. Runs on an interval from server.js
// (same pattern as the other reminder jobs) and sends at most once a day per
// company, after the company's chosen time (Africa/Lagos).
const mongoose = require('mongoose');
const Company = require('../models/Company');
const User = require('../models/User');
const Branch = require('../models/Branch');
const BranchReport = require('../models/BranchReport');
const emailService = require('../services/emailService');
const whatsappService = require('../services/whatsappService');
const { attendantBreakdown } = require('./attendantBreakdown');
const logger = require('./logger');

const TZ = 'Africa/Lagos';
const APP_URL = (process.env.CLIENT_URL || 'http://localhost:5174').split(',')[0].replace(/\/$/, '');

const ymdOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const nowHm = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayStart = (s) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s, n) => { const d = dayStart(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;
const short = (n) => {
  const a = Math.abs(Number(n) || 0);
  if (a >= 1e9) return `₦${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `₦${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `₦${(a / 1e3).toFixed(0)}K`;
  return `₦${Math.round(a)}`;
};
const pct = (now, before) => {
  if (!before) return null;
  const p = Math.round(((now - before) / before) * 100);
  return `${p >= 0 ? '↑' : '↓'} ${Math.abs(p)}%`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LIVE = { status: { $nin: ['draft', 'rejected'] } };

async function salesOn(companyId, branchIds, ymd) {
  const [r] = await BranchReport.aggregate([
    { $match: { companyId, branchId: { $in: branchIds }, reportDate: dayStart(ymd), ...LIVE } },
    { $group: { _id: null, sales: { $sum: '$totals.expectedSales' } } },
  ]);
  return r?.sales || 0;
}

/**
 * Build the summary for one company and day. Returns null if the company has
 * no active branches (nothing to report).
 */
async function buildGroupDigest(rawCompanyId, ymd = ymdOf(new Date())) {
  const companyId = new mongoose.Types.ObjectId(String(rawCompanyId));
  const company = await Company.findById(companyId).select('companyName');
  const branches = await Branch.find({ companyId, status: 'active' }).sort({ name: 1 }).lean();
  if (!company || !branches.length) return null;
  const branchIds = branches.map((b) => b._id);

  const [reports, yesterday, lastWeek, mtdAgg, pendingCount] = await Promise.all([
    BranchReport.find({ companyId, branchId: { $in: branchIds }, reportDate: dayStart(ymd), ...LIVE })
      .select('branchId branchName department status totals shift attendantName attendants pumps collections.credit expenses').lean(),
    salesOn(companyId, branchIds, addDays(ymd, -1)),
    salesOn(companyId, branchIds, addDays(ymd, -7)),
    BranchReport.aggregate([
      { $match: { companyId, branchId: { $in: branchIds }, reportDate: { $gte: dayStart(`${ymd.slice(0, 8)}01`), $lte: dayStart(ymd) }, ...LIVE } },
      { $group: { _id: null, sales: { $sum: '$totals.expectedSales' } } },
    ]),
    BranchReport.countDocuments({ companyId, branchId: { $in: branchIds }, status: { $in: ['pending_branch', 'pending_owner'] } }),
  ]);

  const sum = (arr, f) => arr.reduce((s, r) => s + (f(r) || 0), 0);
  const sales = sum(reports, (r) => r.totals.expectedSales);
  const approved = sum(reports.filter((r) => r.status === 'approved'), (r) => r.totals.expectedSales);
  const litres = sum(reports, (r) => r.totals.litres);

  const perBranch = branches.map((b) => {
    const rs = reports.filter((r) => String(r.branchId) === String(b._id));
    const s = sum(rs, (r) => r.totals.expectedSales);
    const reported = new Set(rs.map((r) => r.department));
    return {
      name: b.name,
      sales: s,
      variance: sum(rs, (r) => r.totals.variance),
      achievement: b.dailySalesTarget ? Math.round((s / b.dailySalesTarget) * 100) : null,
      reportCount: rs.length,
      missing: b.departments.map((d) => d.name).filter((n) => !reported.has(n)),
    };
  }).sort((a, b) => b.sales - a.sales);

  // Who was short today, by name and nozzle (fair split — see attendantBreakdown).
  const people = {};
  reports.forEach((r) => {
    attendantBreakdown(r).forEach((a) => {
      const key = `${a.name}|${r.branchName}`;
      people[key] = people[key] || { name: a.name, branch: r.branchName, variance: 0, nozzles: [] };
      people[key].variance += a.variance;
      a.nozzles.forEach((n) => { if (!people[key].nozzles.includes(n)) people[key].nozzles.push(n); });
    });
  });
  const shortPeople = Object.values(people).filter((p) => p.variance <= -1000).sort((a, b) => a.variance - b.variance);

  const gaps = [];
  reports.forEach((r) => (r.pumps || []).forEach((p) => {
    if (Math.abs(p.meterGap || 0) >= 1) {
      const who = [p.attendant, r.shift?.name && `${r.shift.name} shift`].filter(Boolean).join(', ');
      gaps.push(`${r.branchName} ${p.nozzle || p.pump}: ${p.meterGap > 0 ? '+' : ''}${Math.round(p.meterGap).toLocaleString()} L${who ? ` (${who})` : ''}`);
    }
  }));

  return {
    companyName: company.companyName,
    ymd,
    sales, approved, litres, yesterday, lastWeek,
    mtd: mtdAgg[0]?.sales || 0,
    pendingCount,
    perBranch,
    shortPeople,
    gaps,
    silent: perBranch.filter((b) => !b.reportCount).map((b) => b.name),
  };
}

function digestText(d) {
  const date = dayStart(d.ymd).toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const weekday = dayStart(d.ymd).toLocaleDateString('en-NG', { weekday: 'short', timeZone: 'UTC' });
  const lines = [
    `📊 *${d.companyName}: Daily Summary*`,
    date,
    '',
    `💰 *Sales today: ${naira(d.sales)}*`,
  ];
  const cmp = [pct(d.sales, d.yesterday) && `${pct(d.sales, d.yesterday)} vs yesterday`, pct(d.sales, d.lastWeek) && `${pct(d.sales, d.lastWeek)} vs last ${weekday}`].filter(Boolean);
  if (cmp.length) lines.push(cmp.join(' · '));
  lines.push(`✅ Approved: ${short(d.approved)} · ⏳ Awaiting approval: ${d.pendingCount} report${d.pendingCount === 1 ? '' : 's'}`);
  if (d.litres) lines.push(`⛽ Fuel sold: ${Math.round(d.litres).toLocaleString()} L`);

  lines.push('', '🏢 *Branches*');
  d.perBranch.forEach((b, i) => {
    if (!b.reportCount) { lines.push(`${i + 1}. ${b.name}: ❌ no report today`); return; }
    const flag = b.variance <= -1000 ? `⚠️ short ${naira(Math.abs(b.variance))}` : '✅';
    lines.push(`${i + 1}. ${b.name}: ${short(b.sales)}${b.achievement !== null ? ` (${b.achievement}% of target)` : ''} ${flag}`);
  });

  const attention = [
    ...d.shortPeople.slice(0, 6).map((p) => `• ${p.name} (${p.branch}${p.nozzles.length ? ` · ${p.nozzles.join(', ')}` : ''}): short ${naira(Math.abs(p.variance))}`),
    ...d.gaps.slice(0, 4).map((g) => `• Meter gap ${g}`),
    ...d.perBranch.filter((b) => b.reportCount && b.missing.length).slice(0, 4).map((b) => `• ${b.name}: no report from ${b.missing.join(', ')}`),
  ];
  if (attention.length) lines.push('', '🚨 *Needs attention*', ...attention);
  else lines.push('', '👍 No shortages or meter gaps today.');

  lines.push('', `📅 Month to date: ${naira(d.mtd)}`, '', `Open dashboard: ${APP_URL}/group`);
  return lines.join('\n');
}

function digestHtml(d, text) {
  const body = esc(text).replace(/\*(.+?)\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;font-size:14px;line-height:1.6;color:#0f172a">
    ${body}
    <p style="margin-top:20px"><a href="${APP_URL}/group" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open Command Center</a></p>
  </div>`;
}

async function recipientsFor(company) {
  const owners = await User.find({ companyId: company._id, role: 'company_owner', status: 'active' }).select('name email phone');
  const list = owners.map((u) => ({ name: u.name, email: u.email, phone: u.phone || company.profile?.phone || '' }));
  (company.groupDigest?.recipients || []).forEach((r) => list.push({ name: r.name, email: r.email, phone: r.phone }));
  // Each phone number and each email address gets the summary once, even if
  // the same person is listed twice (e.g. the owner added as an extra recipient).
  const normPhone = (p) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.startsWith('0') && d.length === 11 ? `234${d.slice(1)}` : d;
  };
  const phones = new Set();
  const emails = new Set();
  return list.map((r) => {
    const ph = normPhone(r.phone);
    const em = String(r.email || '').trim().toLowerCase();
    const out = { name: r.name, phone: ph && !phones.has(ph) ? r.phone : '', email: em && !emails.has(em) ? em : '' };
    if (ph) phones.add(ph);
    if (em) emails.add(em);
    return out;
  }).filter((r) => r.phone || r.email);
}

/** Build and send today's summary for one company. Returns delivery results. */
async function sendGroupDigest(companyId, { ymd } = {}) {
  const company = await Company.findById(companyId).select('companyName profile.phone groupDigest');
  const digest = await buildGroupDigest(companyId, ymd);
  if (!company || !digest) return { sent: false, reason: 'No active branches.' };
  const settings = company.groupDigest || {};
  const text = digestText(digest);
  const html = digestHtml(digest, text);
  const recipients = await recipientsFor(company);

  const results = [];
  for (const r of recipients) {
    if (settings.whatsapp !== false && r.phone) {
      // eslint-disable-next-line no-await-in-loop
      const w = await whatsappService.sendToCustomer(companyId, r.phone, text).catch((e) => ({ success: false, reason: e.message }));
      results.push({ to: r.name || r.phone, channel: 'whatsapp', ok: Boolean(w?.success), reason: w?.reason });
    }
    if (settings.email !== false && r.email) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const e = await emailService.sendEmail({ to: r.email, subject: `📊 ${digest.companyName}: ${naira(digest.sales)} today across ${digest.perBranch.length} branches`, html, text });
        results.push({ to: r.name || r.email, channel: 'email', ok: e !== null, reason: e === null ? 'Email is not configured on the server.' : undefined });
      } catch (err) {
        results.push({ to: r.name || r.email, channel: 'email', ok: false, reason: err.message });
      }
    }
  }
  const ok = results.filter((x) => x.ok).length;
  logger.info(`Group digest ${digest.ymd} for ${digest.companyName}: ${ok}/${results.length} delivered`);
  return { sent: ok > 0, results, text };
}

// Interval job: send each company's summary once, after its chosen time.
async function runDueGroupDigests() {
  try {
    const today = ymdOf(new Date());
    const hm = nowHm();
    const companyIds = await Branch.distinct('companyId', { status: 'active' });
    if (!companyIds.length) return;
    const due = await Company.find({
      _id: { $in: companyIds },
      status: 'active',
      'groupDigest.enabled': { $ne: false },
      'groupDigest.lastSentYmd': { $ne: today },
    }).select('groupDigest');

    for (const c of due) {
      if (hm < (c.groupDigest?.time || '21:00')) continue;
      // Claim today's send first so a restart or overlapping run can't double-send.
      // eslint-disable-next-line no-await-in-loop
      const claimed = await Company.updateOne(
        { _id: c._id, 'groupDigest.lastSentYmd': { $ne: today } },
        { $set: { 'groupDigest.lastSentYmd': today } },
      );
      if (!claimed.modifiedCount) continue;
      // eslint-disable-next-line no-await-in-loop
      await sendGroupDigest(c._id, { ymd: today }).catch((e) => logger.error(`Group digest failed for ${c._id}: ${e.message}`));
    }
  } catch (err) {
    logger.error(`Group digest run failed: ${err.message}`);
  }
}

// Interval job: on/after the 1st, email last month's PDF report once.
async function runDueMonthlyReports() {
  try {
    const { emailMonthlyReport, prevMonth } = require('./groupMonthlyReport');
    const today = ymdOf(new Date());
    const lastMonth = prevMonth(today.slice(0, 7));
    if (nowHm() < '07:00') return; // send in the morning, not at midnight
    const companyIds = await Branch.distinct('companyId', {});
    if (!companyIds.length) return;
    const due = await Company.find({
      _id: { $in: companyIds }, status: 'active',
      'groupDigest.enabled': { $ne: false },
      'groupDigest.email': { $ne: false },
      'groupDigest.lastMonthlyYm': { $ne: lastMonth },
    }).select('_id');
    for (const c of due) {
      // eslint-disable-next-line no-await-in-loop
      const claimed = await Company.updateOne({ _id: c._id, 'groupDigest.lastMonthlyYm': { $ne: lastMonth } }, { $set: { 'groupDigest.lastMonthlyYm': lastMonth } });
      if (!claimed.modifiedCount) continue;
      // eslint-disable-next-line no-await-in-loop
      const had = await BranchReport.exists({ companyId: c._id, reportDate: { $gte: dayStart(`${lastMonth}-01`), $lt: dayStart(`${today.slice(0, 7)}-01`) } });
      if (!had) continue; // nothing happened that month — don't send an empty report
      // eslint-disable-next-line no-await-in-loop
      await emailMonthlyReport(c._id, lastMonth).catch((e) => logger.error(`Monthly report failed for ${c._id}: ${e.message}`));
    }
  } catch (err) {
    logger.error(`Monthly report run failed: ${err.message}`);
  }
}

module.exports = { buildGroupDigest, digestText, sendGroupDigest, runDueGroupDigests, runDueMonthlyReports };
