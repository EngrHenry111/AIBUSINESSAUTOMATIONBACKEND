'use strict';

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const User = require('../models/User');
const cache = require('./cache');
const logger = require('./logger');

const UNPAID_PAUSE_THRESHOLD = 3; // consecutive unpaid cycles before auto-pausing

function addInterval(date, interval) {
  const next = new Date(date);
  switch (interval) {
    case 'weekly': next.setDate(next.getDate() + 7); break;
    case 'quarterly': next.setMonth(next.getMonth() + 3); break;
    case 'annually': next.setFullYear(next.getFullYear() + 1); break;
    case 'monthly':
    default: next.setMonth(next.getMonth() + 1); break;
  }
  return next;
}

async function invoiceNumberFor(companyId) {
  const count = await Invoice.countDocuments({ companyId });
  return `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
}

async function notifyOwner(company, subject, message) {
  try {
    const owner = await User.findById(company.owner).select('name email phone');
    if (!owner) return;
    const emailService = require('../services/emailService');
    if (owner.email) {
      const html = emailService.baseTemplate(subject, `<p style="color:#475569;line-height:1.7;">${message}</p>`, { name: company.companyName, logo: company.logo });
      emailService.send({ to: owner.email, subject, html }).catch(() => {});
    }
    if (owner.phone && company.smsSettings?.enabled !== false) {
      const { sendSMS } = require('../services/smsService');
      sendSMS({ to: owner.phone, message: `${subject}: ${message.replace(/<[^>]*>/g, '')} - BizlyAI` }).catch(() => {});
    }
  } catch (e) { logger.warn(`notifyOwner failed: ${e.message}`); }
}

/**
 * Generates the next occurrence for ONE recurring template, if it's due (or
 * `force` is true for a manual "Generate Now"). Shared by the scheduled
 * batch job and the manual trigger so both behave identically — including
 * the unpaid-cycle health check, maxOccurrences/endDate enforcement, and
 * notifications.
 *
 * Returns { generated: Invoice|null, paused: boolean, reason?: string }.
 */
async function generateOneRecurringInvoice(template, { force = false } = {}) {
  const now = new Date();
  const rs = template.recurringSettings || {};

  if (!force) {
    if (!rs.active) return { generated: null, reason: 'not active' };
    if (!rs.nextDueDate || rs.nextDueDate > now) return { generated: null, reason: 'not due yet' };
  }
  // endDate and maxOccurrences are hard limits the owner explicitly
  // configured — unlike active/nextDueDate (which "Generate Now" is meant
  // to override), these stay enforced even under force, or a manual click
  // could generate unlimited invoices past a cap the owner set on purpose.
  if (rs.endDate && rs.endDate < now) return { generated: null, reason: 'past end date' };
  if (rs.maxOccurrences && (rs.totalGenerated || 0) >= rs.maxOccurrences) {
    return { generated: null, reason: `Already reached the max of ${rs.maxOccurrences} occurrence(s).` };
  }

  const company = template.companyId?.companyName ? template.companyId : await Company.findById(template.companyId);
  if (!company) return { generated: null, reason: 'company not found' };

  // ── Credit-risk guard: don't keep invoicing a customer who hasn't paid
  // the last several cycles. This is checked even on a forced/manual
  // generation, since generating into a known-bad situation on purpose
  // isn't something "Generate Now" should silently allow either.
  //
  // consecutiveUnpaid must PERSIST across cycles (1, then 2, then pause at
  // 3) — it's computed here and carried through to the single update at the
  // end of a successful generation, rather than reset mid-function, or the
  // streak would never survive long enough to reach the threshold.
  let consecutiveUnpaid = rs.consecutiveUnpaid || 0;
  if (rs.lastGeneratedInvoiceId) {
    const last = await Invoice.findById(rs.lastGeneratedInvoiceId).select('status');
    const stillUnpaid = Boolean(last) && !['paid', 'cancelled'].includes(last.status);
    consecutiveUnpaid = stillUnpaid ? consecutiveUnpaid + 1 : 0;

    if (stillUnpaid && consecutiveUnpaid >= UNPAID_PAUSE_THRESHOLD) {
      const reason = `Paused after ${consecutiveUnpaid} consecutive unpaid invoices`;
      await Invoice.findByIdAndUpdate(template._id, {
        'recurringSettings.active': false,
        'recurringSettings.consecutiveUnpaid': consecutiveUnpaid,
        'recurringSettings.pausedReason': reason,
      });
      await notifyOwner(
        company,
        `Recurring invoice paused for ${template.customer?.name || 'a customer'}`,
        `${reason} (${template.invoiceNumber}). No new invoice was generated this cycle — review it in BizlyAI and resume manually once resolved.`
      );
      logger.warn(`Recurring invoice ${template._id} auto-paused: ${reason}`);
      return { generated: null, paused: true, reason };
    }
  }

  const invoiceNumber = await invoiceNumberFor(template.companyId?._id || template.companyId);
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 14); // 14 days to pay, matching the original spec

  let newInvoice;
  try {
    newInvoice = await Invoice.create({
      companyId: template.companyId?._id || template.companyId,
      invoiceNumber,
      customer: template.customer,
      items: template.items,
      subtotal: template.subtotal,
      tax: template.tax,
      discount: template.discount,
      total: template.total,
      currency: template.currency,
      notes: template.notes,
      status: 'sent',
      issuedAt: now,
      dueAt,
      isRecurring: false, // the generated copy is a plain invoice, not itself a template
      recurringParentId: template._id,
      createdBy: template.createdBy,
    });
  } catch (err) {
    logger.error(`Failed to generate recurring invoice from template ${template._id}: ${err.message}`);
    return { generated: null, reason: err.message };
  }

  // Dispatch email/SMS the same way a manually-sent invoice would.
  const { dispatchInvoiceToCustomer } = require('../controllers/invoiceController');
  await dispatchInvoiceToCustomer(newInvoice, company).catch((e) => logger.warn(`Recurring invoice dispatch failed: ${e.message}`));

  const totalGenerated = (rs.totalGenerated || 0) + 1;
  const hitMaxOccurrences = rs.maxOccurrences && totalGenerated >= rs.maxOccurrences;

  await Invoice.findByIdAndUpdate(template._id, {
    'recurringSettings.lastGeneratedAt': now,
    'recurringSettings.lastGeneratedInvoiceId': newInvoice._id,
    'recurringSettings.nextDueDate': addInterval(rs.nextDueDate || now, rs.interval),
    'recurringSettings.totalGenerated': totalGenerated,
    'recurringSettings.consecutiveUnpaid': consecutiveUnpaid, // 0 if the last cycle was paid (or this is the first ever)
    ...(hitMaxOccurrences ? { 'recurringSettings.active': false, 'recurringSettings.pausedReason': `Reached max occurrences (${rs.maxOccurrences})` } : {}),
  });

  const companyId = String(template.companyId?._id || template.companyId);
  cache.del(`dashboard_${companyId}`);
  const teamUserIds = await User.find({ companyId }).select('_id').lean();
  teamUserIds.forEach((u) => cache.del(`notifications_${u._id}`));

  const io = global.io;
  if (io) {
    io.to(`company:${companyId}`).emit('invoice:recurring_generated', {
      invoiceId: newInvoice._id,
      invoiceNumber: newInvoice.invoiceNumber,
      customer: newInvoice.customer?.name,
      amount: newInvoice.total,
    });
    io.to(`company:${companyId}`).emit('notification:refresh', { type: 'recurring_invoice', invoiceNumber: newInvoice.invoiceNumber });
  }

  console.log(`✅ Recurring invoice generated: ${newInvoice._id} (${newInvoice.invoiceNumber}) from template ${template._id}`);
  return { generated: newInvoice };
}

async function processRecurringInvoices() {
  try {
    const now = new Date();
    const dueTemplates = await Invoice.find({
      isRecurring: true,
      'recurringSettings.active': true,
      'recurringSettings.nextDueDate': { $lte: now },
      $or: [
        { 'recurringSettings.endDate': null },
        { 'recurringSettings.endDate': { $exists: false } },
        { 'recurringSettings.endDate': { $gte: now } },
      ],
    }).populate('companyId');

    console.log(`Processing ${dueTemplates.length} recurring invoice(s) due`);

    let generated = 0;
    let paused = 0;
    for (const template of dueTemplates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await generateOneRecurringInvoice(template);
        if (result.generated) generated += 1;
        if (result.paused) paused += 1;
      } catch (err) {
        console.error(`❌ Failed to process recurring invoice ${template._id}:`, err.message);
      }
    }
    if (generated || paused) {
      logger.warn(`Recurring invoices: ${generated} generated, ${paused} auto-paused (${dueTemplates.length} due)`);
    }
  } catch (err) {
    logger.error(`processRecurringInvoices failed: ${err.message}`);
  }
}

module.exports = { processRecurringInvoices, generateOneRecurringInvoice, addInterval };
