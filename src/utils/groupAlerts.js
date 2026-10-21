'use strict';

const User = require('../models/User');
const Company = require('../models/Company');
const BranchReport = require('../models/BranchReport');
const emailService = require('../services/emailService');
const whatsappService = require('../services/whatsappService');
const { sendSMS } = require('../services/smsService');
const logger = require('./logger');

// A submitted report short by at least this much (₦) pings the owner and the
// branch manager straight away — email, WhatsApp (from the business's own
// connected number) and SMS where enabled.
const SHORTAGE_ALERT = Number(process.env.GROUP_SHORTAGE_ALERT) || 50000;
const APP_URL = (process.env.CLIENT_URL || 'http://localhost:5174').split(',')[0].replace(/\/$/, '');

const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function notifyShortage(report, branch) {
  const t = report.totals || {};
  if (t.variance > -SHORTAGE_ALERT || report.shortageAlertedAt || report.demo) return;

  // Claim the alert first so a resubmit/race never double-sends.
  const claimed = await BranchReport.updateOne(
    { _id: report._id, shortageAlertedAt: null },
    { $set: { shortageAlertedAt: new Date() } },
  );
  if (!claimed.modifiedCount) return;

  const company = await Company.findById(report.companyId).select('companyName profile.phone');
  const ids = [branch.managerId].filter(Boolean);
  const recipients = await User.find({
    companyId: report.companyId,
    status: 'active',
    $or: [{ role: 'company_owner' }, { _id: { $in: ids } }],
  }).select('name email phone role');

  const link = `${APP_URL}/group/reports/${report._id}`;
  const short = naira(Math.abs(t.variance));
  const text = [
    `⚠️ CASH SHORTAGE: ${short}`,
    `${report.branchName} · ${report.department}`,
    `Date: ${day(report.reportDate)}`,
    `Expected sales: ${naira(t.expectedSales)}`,
    `Collected: ${naira(t.collected)}${t.expenses ? ` (+ ${naira(t.expenses)} expenses)` : ''}`,
    `Prepared by: ${report.preparedByName || '—'} · ${report.referenceNumber}`,
    '',
    `Review: ${link}`,
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
      <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:16px 20px;border-radius:8px">
        <div style="font-size:12px;color:#991b1b;font-weight:bold;letter-spacing:.06em">CASH SHORTAGE ALERT</div>
        <div style="font-size:28px;font-weight:bold;color:#b91c1c;margin-top:4px">${short}</div>
        <div style="color:#7f1d1d">${esc(report.branchName)} · ${esc(report.department)} · ${day(report.reportDate)}</div>
      </div>
      <table style="width:100%;margin-top:16px;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#64748b">Expected sales</td><td style="text-align:right">${naira(t.expectedSales)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Collected</td><td style="text-align:right">${naira(t.collected)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Expenses</td><td style="text-align:right">${naira(t.expenses)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Prepared by</td><td style="text-align:right">${esc(report.preparedByName || '—')}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Reference</td><td style="text-align:right">${esc(report.referenceNumber)}</td></tr>
      </table>
      <a href="${link}" style="display:inline-block;margin-top:18px;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Review report</a>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">${esc(company?.companyName || '')} · Group Operations</p>
    </div>`;

  const sends = [];
  recipients.forEach((u) => {
    if (u.email) {
      sends.push(emailService.sendEmail({
        to: u.email,
        subject: `⚠️ ${short} short at ${report.branchName} (${report.department})`,
        html,
        text,
      }));
    }
    const phone = u.phone || (u.role === 'company_owner' ? company?.profile?.phone : null);
    if (phone) {
      sends.push(whatsappService.sendToCustomer(report.companyId, phone, text));
      sends.push(sendSMS({ to: phone, message: `${report.branchName}: ${short} cash shortage (${report.department}, ${day(report.reportDate)}). ${link}` }));
    }
  });

  const results = await Promise.allSettled(sends);
  const failed = results.filter((r) => r.status === 'rejected' || r.value?.success === false).length;
  logger.info(`Shortage alert ${report.referenceNumber} (${short}) → ${recipients.length} recipient(s), ${sends.length - failed}/${sends.length} sends ok`);
}

// Fire-and-forget wrapper — an alert failure must never fail the report submit.
function alertIfShort(report, branch) {
  notifyShortage(report, branch).catch((err) => logger.error(`Shortage alert failed for ${report.referenceNumber}: ${err.message}`));
}

module.exports = { alertIfShort, notifyShortage, SHORTAGE_ALERT };
