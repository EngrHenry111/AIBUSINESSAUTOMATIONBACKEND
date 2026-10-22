'use strict';

// Credit customer maths and reminders.
//
// Aging uses first-in-first-out: payments clear the oldest debts first, and
// whatever is left of each sale is bucketed by how many days past its due
// date it is. Reminders go out (email + WhatsApp from the business number)
// at most once every 7 days per customer while something is overdue.
const GroupCreditCustomer = require('../models/GroupCreditCustomer');
const GroupCreditTxn = require('../models/GroupCreditTxn');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const whatsappService = require('../services/whatsappService');
const logger = require('./logger');

const DAY = 24 * 60 * 60 * 1000;
const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];
const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;
const day = (d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function bucketFor(daysOverdue) {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

/** Aging for one customer's transactions (any order). */
function computeAging(txns, asOf = new Date()) {
  const debts = txns.filter((t) => t.amount > 0)
    .map((t) => ({ date: new Date(t.date), due: new Date(t.dueDate || t.date), left: t.amount, reference: t.reference }))
    .sort((a, b) => a.date - b.date);
  let credit = -txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  for (const d of debts) {
    if (credit <= 0) break;
    const used = Math.min(d.left, credit);
    d.left -= used;
    credit -= used;
  }
  const aging = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  let oldestOverdueDays = 0;
  debts.filter((d) => d.left > 0.005).forEach((d) => {
    const overdue = Math.floor((asOf - d.due) / DAY);
    aging[bucketFor(overdue)] += d.left;
    if (overdue > oldestOverdueDays) oldestOverdueDays = overdue;
  });
  const outstanding = BUCKETS.reduce((s, b) => s + aging[b], 0);
  return {
    aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    outstanding: Math.round(outstanding * 100) / 100,
    overdue: Math.round((outstanding - aging.notDue) * 100) / 100,
    oldestOverdueDays,
    unappliedCredit: Math.round(Math.max(0, credit) * 100) / 100, // overpaid / advance
  };
}

async function agingFor(customerIds, asOf) {
  const txns = await GroupCreditTxn.find({ customerId: { $in: customerIds } }).select('customerId amount date dueDate reference').lean();
  const by = {};
  txns.forEach((t) => { (by[String(t.customerId)] = by[String(t.customerId)] || []).push(t); });
  return Object.fromEntries(customerIds.map((id) => [String(id), computeAging(by[String(id)] || [], asOf)]));
}

function reminderText(company, customer, a) {
  return [
    `Dear ${customer.contactName || customer.name},`,
    '',
    `This is a friendly reminder from ${company.companyName}.`,
    `Your account balance is ${naira(a.outstanding)}, of which ${naira(a.overdue)} is past due${a.oldestOverdueDays ? ` (oldest ${a.oldestOverdueDays} days overdue)` : ''}.`,
    '',
    'Please arrange payment at your earliest convenience. If you have already paid, kindly share the payment reference so we can update your account.',
    '',
    `Thank you,\n${company.companyName}${company.profile?.phone ? `\n${company.profile.phone}` : ''}`,
  ].join('\n');
}

/** Send one payment reminder now. Returns per-channel results. */
async function sendCreditReminder(customer) {
  const company = await Company.findById(customer.companyId).select('companyName profile');
  const [a] = Object.values(await agingFor([customer._id]));
  if (!a || a.outstanding <= 0) return { sent: false, reason: 'Nothing is owed.', results: [] };
  const text = reminderText(company, customer, a);
  const results = [];
  if (customer.phone) {
    const w = await whatsappService.sendToCustomer(customer.companyId, customer.phone, text).catch((e) => ({ success: false, reason: e.message }));
    results.push({ channel: 'whatsapp', ok: Boolean(w?.success), reason: w?.reason });
  }
  if (customer.email) {
    try {
      const e = await emailService.sendEmail({
        to: customer.email,
        subject: `Payment reminder: ${naira(a.overdue || a.outstanding)} due to ${company.companyName}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6">${esc(text).replace(/\n/g, '<br>')}</div>`,
        text,
        replyTo: company.profile?.email || undefined,
      });
      results.push({ channel: 'email', ok: e !== null, reason: e === null ? 'Email is not configured on the server.' : undefined });
    } catch (err) {
      results.push({ channel: 'email', ok: false, reason: err.message });
    }
  }
  const ok = results.some((r) => r.ok);
  if (ok) await GroupCreditCustomer.updateOne({ _id: customer._id }, { $set: { lastReminderAt: new Date() } });
  return { sent: ok, results, aging: a };
}

// Interval job: weekly automatic reminders for overdue accounts.
async function runCreditReminders() {
  try {
    const weekAgo = new Date(Date.now() - 7 * DAY);
    const customers = await GroupCreditCustomer.find({
      active: true, autoRemind: true, balance: { $gt: 0 },
      $and: [
        { $or: [{ phone: { $nin: ['', null] } }, { email: { $nin: ['', null] } }] },
        { $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: weekAgo } }] },
      ],
    }).limit(200);
    if (!customers.length) return;
    const aging = await agingFor(customers.map((c) => c._id));
    let sent = 0;
    for (const c of customers) {
      if ((aging[String(c._id)]?.overdue || 0) <= 0) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await sendCreditReminder(c).catch((e) => ({ sent: false, reason: e.message }));
      if (r.sent) sent += 1;
    }
    if (sent) logger.info(`Credit reminders: ${sent} sent`);
  } catch (err) {
    logger.error(`Credit reminder run failed: ${err.message}`);
  }
}

module.exports = { computeAging, agingFor, sendCreditReminder, runCreditReminders, BUCKETS, day };
