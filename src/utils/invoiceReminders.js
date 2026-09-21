'use strict';

// Automatic overdue-invoice reminders — email + SMS, once every 24h per
// invoice. Runs on an interval from server.js, same pattern as
// subscriptionChecker.js / meetingReminders.js.
//
// This closes a real gap: invoiceController.draftReminder() already used AI
// to draft reminder text, emailService.sendInvoiceReminder() already
// existed, and Invoice.reminders.method already had 'sms' in its enum — but
// nothing ever actually SENT an automatic reminder; a human had to draft one
// and send it by hand every time. This makes overdue reminders self-driving,
// which is exactly the kind of thing a Nigerian SME chasing invoice payments
// needs and shouldn't have to remember to do manually.
const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { sendPaymentReminderSMS } = require('../services/smsService');
const logger = require('./logger');

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function checkOverdueInvoices() {
  try {
    const now = new Date();
    const overdue = await Invoice.find({
      status: { $in: ['sent', 'viewed', 'overdue'] },
      dueAt: { $lt: now },
    });
    if (!overdue.length) return;

    let sent = 0;
    for (const invoice of overdue) {
      // eslint-disable-next-line no-await-in-loop
      const lastReminder = invoice.reminders?.[invoice.reminders.length - 1];
      if (lastReminder?.sentAt && now - new Date(lastReminder.sentAt) < REMINDER_INTERVAL_MS) continue;
      if (!invoice.customer?.email && !invoice.customer?.phone) continue;

      // eslint-disable-next-line no-await-in-loop
      const company = await Company.findById(invoice.companyId).select('companyName logo profile smsSettings');
      const daysOverdue = Math.floor((now - new Date(invoice.dueAt)) / (1000 * 60 * 60 * 24));

      if (invoice.customer.email) {
        // eslint-disable-next-line no-await-in-loop
        await emailService.sendInvoiceReminder(
          invoice.customer.email, invoice.customer.name, invoice.invoiceNumber,
          invoice.total, invoice.dueAt,
          `This is an automatic reminder that invoice ${invoice.invoiceNumber} is ${daysOverdue} day(s) overdue.`
        ).catch((e) => logger.warn(`Auto invoice-reminder email failed for ${invoice.invoiceNumber}: ${e.message}`));
      }
      if (invoice.customer.phone && company?.smsSettings?.enabled !== false && company?.smsSettings?.sendInvoiceSMS !== false) {
        // eslint-disable-next-line no-await-in-loop
        await sendPaymentReminderSMS(invoice.customer.phone, invoice.customer.name, invoice.invoiceNumber, invoice.total, daysOverdue).catch(() => {});
      }

      if (invoice.status !== 'overdue') invoice.status = 'overdue';
      invoice.reminders.push({ sentAt: now, method: 'email', aiGenerated: false, messagePreview: `Automatic overdue reminder (${daysOverdue}d overdue)` });
      // eslint-disable-next-line no-await-in-loop
      await invoice.save();
      sent += 1;
    }

    if (sent) logger.warn(`Overdue invoice reminders: sent ${sent} of ${overdue.length} eligible invoice(s)`);
  } catch (err) {
    logger.error(`checkOverdueInvoices failed: ${err.message}`);
  }
}

module.exports = { checkOverdueInvoices };
