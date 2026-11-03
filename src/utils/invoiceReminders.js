'use strict';

// Automatic overdue-invoice reminders, by email and SMS. Runs daily from
// server.js. Each invoice gets at most one reminder per step of SCHEDULE
// (days overdue), then they stop, so a customer is chased firmly but not
// forever. Off for a whole business with Company.invoiceReminders.enabled,
// or for one invoice with Invoice.remindersPaused. Invoices for store orders
// are left alone: the order's own payment (on delivery, or the second half
// of a split payment) collects them, and a pay link could get paid twice.

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { sendPaymentReminderSMS } = require('../services/smsService');
const { balanceOf, moneyOf, canPayOnline, payLink } = require('./invoicePayments');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE = [1, 3, 7, 14];
// Never two reminders (automatic or by hand) within this gap.
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Reminders this job has sent, counting the ones from before `auto` existed.
const autoCount = (invoice) => (invoice.reminders || []).filter((r) => r.auto || /^Automatic overdue reminder/.test(r.messagePreview || '')).length;

function reminderHtml({ invoice, company, balance, daysOverdue, url }) {
  const ps = company?.paymentSettings;
  const bank = ps?.isPaymentSetup ? ps : null;
  const amount = moneyOf(balance, invoice.currency);
  const partly = (invoice.amountPaid || 0) > 0;
  return `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Payment reminder</h2>
    <p style="color:#475569;margin:0 0 20px;">Dear ${esc(invoice.customer.name)},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 20px;">
      This is a reminder that invoice <strong>${esc(invoice.invoiceNumber)}</strong> from ${esc(company?.companyName || 'us')}
      was due on <strong>${day(invoice.dueAt)}</strong> and is now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fcd34d;border-radius:12px;margin:0 0 24px;">
      <tr><td style="padding:18px 20px;">
        <p style="color:#92400e;margin:0;font-size:13px;">${partly ? 'Balance still due' : 'Amount due'}</p>
        <p style="color:#92400e;margin:4px 0 0;font-size:24px;font-weight:800;">${esc(amount)}</p>
        ${partly ? `<p style="color:#92400e;margin:6px 0 0;font-size:13px;">${esc(moneyOf(invoice.amountPaid, invoice.currency))} of ${esc(moneyOf(invoice.total, invoice.currency))} received. Thank you.</p>` : ''}
      </td></tr>
    </table>
    ${url ? `
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${esc(url)}" style="background:#0e2a22;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">Pay ${esc(amount)} now</a>
      <p style="color:#94a3b8;font-size:12px;margin:10px 0 0;">Card, bank transfer or USSD, through Paystack.</p>
    </div>` : ''}
    ${bank ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 20px;">
      <tr><td style="padding:16px 20px;">
        <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:700;margin:0 0 8px;">${url ? 'Or pay by bank transfer' : 'Pay by bank transfer'}</p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0;">
          Bank: <strong>${esc(bank.bankName || '—')}</strong><br/>
          Account name: <strong>${esc(bank.accountName || '—')}</strong><br/>
          Account number: <strong>${esc(bank.accountNumber || '—')}</strong><br/>
          Reference: <strong>${esc(invoice.invoiceNumber)}</strong>
        </p>
      </td></tr>
    </table>` : ''}
    <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0;">If you've already paid, thank you, and please ignore this message. Questions? Just reply to this email.</p>`;
}

async function remind(invoice, company, now) {
  const balance = balanceOf(invoice);
  const daysOverdue = Math.max(1, Math.floor((now - new Date(invoice.dueAt)) / DAY_MS));
  const url = canPayOnline(company, invoice) ? await payLink(invoice) : null;
  const amount = moneyOf(balance, invoice.currency);
  const channels = [];

  if (invoice.customer.email) {
    const html = emailService.baseTemplate(`Payment reminder: invoice ${invoice.invoiceNumber}`, reminderHtml({ invoice, company, balance, daysOverdue, url }),
      { name: company?.companyName, logo: company?.logo, tagline: company?.profile?.tagline });
    const sent = await emailService.sendEmail({
      to: invoice.customer.email,
      subject: `Payment reminder: invoice ${invoice.invoiceNumber} (${amount} due)`,
      html,
      ...(company?.profile?.email && { replyTo: company.profile.email }),
    }).catch((e) => { logger.warn(`Overdue reminder email failed for ${invoice.invoiceNumber}: ${e.message}`); return null; });
    if (sent) channels.push('email');
  }
  if (invoice.customer.phone && company?.smsSettings?.enabled !== false && company?.smsSettings?.sendInvoiceSMS !== false) {
    // sendSMS returns null, not an error, when SMS is switched off or fails.
    const ok = await sendPaymentReminderSMS(invoice.customer.phone, invoice.customer.name, invoice.invoiceNumber, amount, daysOverdue, company?.companyName, url)
      .then(Boolean, () => false);
    if (ok) channels.push('sms');
  }
  return { channels, daysOverdue };
}

async function checkOverdueInvoices() {
  try {
    const now = new Date();
    const overdue = await Invoice.find({
      status: { $in: ['sent', 'viewed', 'partial', 'overdue'] },
      dueAt: { $lt: new Date(now - DAY_MS) },
      remindersPaused: { $ne: true },
      orderId: null,
    });
    if (!overdue.length) return;

    const companies = new Map();
    let sent = 0;
    for (const invoice of overdue) {
      if (balanceOf(invoice) <= 0) continue;
      if (!invoice.customer?.email && !invoice.customer?.phone) continue;
      const step = autoCount(invoice);
      if (step >= SCHEDULE.length) continue;
      const daysOverdue = Math.floor((now - new Date(invoice.dueAt)) / DAY_MS);
      if (daysOverdue < SCHEDULE[step]) continue;
      const last = invoice.reminders?.[invoice.reminders.length - 1];
      if (last?.sentAt && now - new Date(last.sentAt) < MIN_GAP_MS) continue;

      const cid = String(invoice.companyId);
      if (!companies.has(cid)) {
        // eslint-disable-next-line no-await-in-loop
        companies.set(cid, await Company.findById(cid).select('companyName logo profile smsSettings paymentSettings invoiceReminders'));
      }
      const company = companies.get(cid);
      if (!company || company.invoiceReminders?.enabled === false) continue;

      // eslint-disable-next-line no-await-in-loop
      const { channels } = await remind(invoice, company, now);
      if (!channels.length) continue;
      if (invoice.status !== 'partial') invoice.status = 'overdue';
      invoice.reminders.push({
        sentAt: now, method: channels[0], auto: true, aiGenerated: false,
        messagePreview: `Automatic overdue reminder ${step + 1} of ${SCHEDULE.length} (${daysOverdue}d overdue, by ${channels.join(' and ')})`,
      });
      // eslint-disable-next-line no-await-in-loop
      await invoice.save();
      sent += 1;
    }
    if (sent) logger.warn(`Overdue invoice reminders: sent ${sent} of ${overdue.length} overdue invoice(s)`);
  } catch (err) {
    logger.error(`checkOverdueInvoices failed: ${err.message}`);
  }
}

module.exports = { checkOverdueInvoices, remind, SCHEDULE, MIN_GAP_MS, reminderHtml, autoCount };
