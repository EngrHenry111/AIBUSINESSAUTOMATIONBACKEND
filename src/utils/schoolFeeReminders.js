'use strict';

// Fee reminders to parents — one message per student summing everything
// they owe, by email, SMS and (if the school's WhatsApp is connected)
// WhatsApp. Used by the "Send reminders" button and by the daily automatic
// run. Each bill remembers when it was last chased so parents are never
// spammed (manual: not again within 12h; automatic: the school's interval).

const FeeBill = require('../models/FeeBill');
const Student = require('../models/Student');
const SchoolSettings = require('../models/SchoolSettings');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { sendSMS } = require('../services/smsService');
const logger = require('./logger');
const { TERM_LABEL, getSettings, emitSchool } = require('./school');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

// Lazily required — whatsapp-web.js pulls in puppeteer.
function whatsapp() {
  try { return require('../services/whatsappService'); } catch { return null; }
}

/**
 * Finds who to remind. Options:
 *   studentIds / classId — narrow the target (default: everyone who owes)
 *   billIds              — exact bills (used by the automatic run)
 *   notRemindedWithinMs  — skip bills chased more recently than this
 */
async function collectTargets(companyId, { studentIds, classId, billIds, notRemindedWithinMs = 12 * HOUR } = {}) {
  const filter = { companyId, status: { $in: ['unpaid', 'partial'] }, balance: { $gt: 0 } };
  if (billIds) filter._id = { $in: billIds };
  let students;
  if (studentIds?.length || classId) {
    const sf = { companyId, status: 'active' };
    if (studentIds?.length) sf._id = { $in: studentIds };
    if (classId) sf.classId = classId;
    students = await Student.find(sf).select('_id').lean();
    filter.studentId = { $in: students.map((s) => s._id) };
  }
  const bills = await FeeBill.find(filter).select('studentId balance title session term dueDate lastReminderAt').lean();
  const cutoff = Date.now() - notRemindedWithinMs;
  const fresh = bills.filter((b) => !b.lastReminderAt || new Date(b.lastReminderAt).getTime() < cutoff);

  const byStudent = new Map();
  for (const b of fresh) {
    const k = String(b.studentId);
    if (!byStudent.has(k)) byStudent.set(k, []);
    byStudent.get(k).push(b);
  }
  const people = await Student.find({ _id: { $in: [...byStudent.keys()] }, status: 'active' })
    .select('firstName lastName admissionNumber guardian').lean();
  return {
    targets: people.map((s) => ({ student: s, bills: byStudent.get(String(s._id)) })),
    skippedRecent: new Set(bills.filter((b) => !fresh.includes(b)).map((b) => String(b.studentId))).size,
  };
}

function messagesFor(settings, student, bills, payLink, account) {
  const owed = bills.reduce((s, b) => s + b.balance, 0);
  const due = bills.map((b) => b.dueDate).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
  const overdue = due && new Date(due) < new Date();
  const who = `${student.firstName} ${student.lastName} (${student.admissionNumber})`;
  const school = settings.schoolName || 'School';
  const dueText = due ? (overdue ? `, which was due on ${fmtDate(due)}` : `, due on ${fmtDate(due)}`) : '';
  const transferText = account ? ` Pay by transfer to ${account.bankName} ${account.accountNumber} (credited automatically).` : '';
  const sms = `${school}: ${who} has outstanding school fees of ${naira(owed)}${dueText}.${transferText}${payLink ? ` Pay online: ${payLink}` : ''} Thank you.`;
  const text = `Dear ${student.guardian?.name || 'Parent'},\n\n${sms.replace(`${school}: `, '')}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">
    <h2 style="margin:0 0 12px">${escapeHtml(school)}</h2>
    <p>Dear ${escapeHtml(student.guardian?.name || 'Parent')},</p>
    <p>This is a friendly reminder that <b>${escapeHtml(who)}</b> has outstanding school fees of <b>${naira(owed)}</b>${escapeHtml(dueText)}.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
      ${bills.map((b) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e2e8f0">${escapeHtml(b.title || 'School fees')} · ${escapeHtml(b.session)} ${TERM_LABEL[b.term] || ''}</td><td style="padding:6px 0;border-bottom:1px solid #e2e8f0;text-align:right">${naira(b.balance)}</td></tr>`).join('')}
    </table>
    ${account ? `<p style="padding:10px 12px;background:#f1f5f9;border-radius:8px">Pay by bank transfer to <b>${escapeHtml(account.bankName)} ${escapeHtml(account.accountNumber)}</b>${account.accountName ? ` (${escapeHtml(account.accountName)})` : ''} — it's ${escapeHtml(student.firstName)}'s own account, so the payment is credited automatically.</p>` : ''}
    ${payLink ? `<p><a href="${payLink}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Pay online</a></p>` : '<p>Please pay at the school bursary.</p>'}
    <p style="color:#64748b;font-size:12px">If you have already paid, please ignore this message. ${escapeHtml([settings.phone, settings.email].filter(Boolean).join(' · '))}</p>
  </div>`;
  return { owed, sms, text, html, subject: `School fees reminder — ${student.firstName} ${student.lastName}` };
}

/**
 * Sends reminders and records them on the bills. Returns delivery counts —
 * "sent" only counts messages a provider actually accepted.
 */
async function sendFeeReminders(companyId, opts = {}) {
  const settings = await getSettings(companyId);
  const company = await Company.findById(companyId).select('smsSettings paymentSettings').lean();
  const channels = {
    email: opts.channels?.email ?? settings.reminders?.email ?? true,
    sms: (opts.channels?.sms ?? settings.reminders?.sms ?? true) && company?.smsSettings?.enabled !== false,
    whatsapp: opts.channels?.whatsapp ?? settings.reminders?.whatsapp ?? false,
  };
  const wa = channels.whatsapp ? whatsapp() : null;
  const waReady = Boolean(wa && wa.getStatus(companyId)?.status === 'connected');
  const payLink = settings.onlinePaymentsEnabled && company?.paymentSettings?.isPaymentSetup
    ? `${clientUrl()}/schools/${settings.slug}/portal` : null;

  const notRemindedWithinMs = opts.notRemindedWithinMs ?? 12 * HOUR;
  const { targets, skippedRecent } = await collectTargets(companyId, { ...opts, notRemindedWithinMs });
  const accounts = new Map((await require('../models/VirtualAccount').find({ companyId, ownerType: 'student', ownerId: { $in: targets.map((t) => t.student._id) } }).lean()).map((a) => [String(a.ownerId), a]));
  const result = { students: 0, email: 0, sms: 0, whatsapp: 0, noContact: 0, failed: 0, skippedRecent, whatsappConnected: waReady };

  for (const { student, bills } of targets) {
    const g = student.guardian || {};
    if (!g.email && !g.phone) { result.noContact += 1; continue; }
    // Claim the bills first: a concurrent run (double click, two staff,
    // the daily job) that already claimed them makes this a no-op, so a
    // parent is never messaged twice. Recorded even if no provider accepts
    // the message, so a misconfigured provider can't cause a retry storm.
    const cutoff = new Date(Date.now() - notRemindedWithinMs);
    // eslint-disable-next-line no-await-in-loop
    const claim = await FeeBill.updateMany(
      { _id: { $in: bills.map((b) => b._id) }, $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: cutoff } }] },
      { $set: { lastReminderAt: new Date() }, $inc: { reminderCount: 1 } },
    );
    if (!claim.modifiedCount) { result.skippedRecent += 1; continue; }
    result.students += 1;
    const m = messagesFor(settings, student, bills, payLink, accounts.get(String(student._id)));
    let reached = false;
    try {
      if (channels.email && g.email) {
        // eslint-disable-next-line no-await-in-loop
        if (await emailService.sendEmail({ to: g.email, subject: m.subject, html: m.html, text: m.text })) { result.email += 1; reached = true; }
      }
      if (channels.sms && g.phone) {
        // eslint-disable-next-line no-await-in-loop
        if (await sendSMS({ to: g.phone, message: m.sms })) { result.sms += 1; reached = true; }
      }
      if (waReady && g.phone) {
        // eslint-disable-next-line no-await-in-loop
        if ((await wa.sendToCustomer(companyId, g.phone, m.text))?.success) { result.whatsapp += 1; reached = true; }
      }
    } catch (err) {
      logger.error(`Fee reminder for ${student.admissionNumber} failed: ${err.message}`);
    }
    if (!reached) result.failed += 1;
  }
  return result;
}

// Daily automatic run (called hourly from server.js, acts at 9am Lagos).
async function runAutomaticFeeReminders(io) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: process.env.SCHOOL_TZ || 'Africa/Lagos', hour: '2-digit', hour12: false }).format(new Date()));
  if (hour === 9) await remindDueBillsNow(io);
}

// The work itself — every school with automatic reminders on, bills due
// within the school's window (or overdue), not chased within its interval.
async function remindDueBillsNow(io) {
  try {
    const schools = await SchoolSettings.find({ 'reminders.autoEnabled': true }).select('companyId reminders').lean();
    for (const s of schools) {
      const { daysBeforeDue = 3, repeatEveryDays = 7 } = s.reminders || {};
      // eslint-disable-next-line no-await-in-loop
      const billIds = await FeeBill.find({
        companyId: s.companyId,
        status: { $in: ['unpaid', 'partial'] },
        balance: { $gt: 0 },
        dueDate: { $ne: null, $lte: new Date(Date.now() + daysBeforeDue * DAY) },
      }).distinct('_id');
      if (!billIds.length) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await sendFeeReminders(s.companyId, { billIds, notRemindedWithinMs: repeatEveryDays * DAY - HOUR });
      if (result.students) {
        logger.warn(`Automatic fee reminders for company ${s.companyId}: ${JSON.stringify(result)}`);
        emitSchool(io, s.companyId, 'reminders', { result, automatic: true });
      }
    }
  } catch (err) {
    logger.error(`Automatic fee reminders failed: ${err.message}`);
  }
}

module.exports = { sendFeeReminders, collectTargets, runAutomaticFeeReminders, remindDueBillsNow };
