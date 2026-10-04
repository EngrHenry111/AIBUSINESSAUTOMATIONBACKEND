'use strict';

// Edit-and-send for AI drafts (invoice payment reminders, appointment
// confirmations, lead follow-ups). The AI writes the first version; the
// user edits it, then sends it as a branded email with optional file
// attachments and — for invoices — the invoice itself as a PDF.
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const Lead = require('../models/Lead');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const { renderInvoicePdf } = require('../utils/invoicePdf');

// Where each draft lives and who it goes to by default.
const CONTEXTS = {
  invoice: { model: Invoice, field: 'reminderDraft', recipient: (d) => d.customer?.email, name: (d) => d.customer?.name },
  appointment: { model: Appointment, field: 'confirmationDraft', recipient: (d) => d.customer?.email, name: (d) => d.customer?.name },
  lead: { model: Lead, field: 'followUpDraft', recipient: (d) => d.email, name: (d) => d.name },
};

const MAX_DRAFT = 20000;
const MAX_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadContext(req) {
  const ctx = CONTEXTS[req.params.type];
  if (!ctx) throw new AppError('Unknown draft type.', 404);
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Not found.', 404);
  const doc = await ctx.model.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!doc) throw new AppError('Not found.', 404);
  return { ctx, doc };
}

function parseEmails(value) {
  const list = (Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/))
    .map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const bad = list.find((e) => !EMAIL_RE.test(e));
  if (bad) throw new AppError(`"${bad}" is not a valid email address.`, 400);
  return [...new Set(list)];
}

// Plain text → simple, safe HTML: paragraphs on blank lines, <br> inside.
function textToHtml(text) {
  return String(text).trim().split(/\n{2,}/)
    .map((p) => `<p style="color:#334155;line-height:1.7;margin:0 0 16px;font-size:15px;">${esc(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function saveDraftText(ctx, doc, text) {
  doc.ai = { ...(doc.ai?.toObject?.() || doc.ai || {}), [ctx.field]: text };
}

// ── PUT /drafts/:type/:id — save the edited draft ─────────────────────────
exports.saveDraft = async (req, res, next) => {
  try {
    const { ctx, doc } = await loadContext(req);
    const text = String(req.body.text ?? '').slice(0, MAX_DRAFT);
    saveDraftText(ctx, doc, text);
    await doc.save();
    res.status(200).json({ success: true, data: { text } });
  } catch (err) { next(err); }
};

// ── POST /drafts/:type/:id/send — multipart: to, cc, subject, body,
//    attachInvoicePdf, files[] ─────────────────────────────────────────────
exports.sendDraft = async (req, res, next) => {
  try {
    const { ctx, doc } = await loadContext(req);
    const to = parseEmails(req.body.to || ctx.recipient(doc));
    const cc = parseEmails(req.body.cc);
    if (!to.length) return next(new AppError('Add at least one recipient.', 400));
    if (to.length + cc.length > MAX_RECIPIENTS) return next(new AppError(`Up to ${MAX_RECIPIENTS} recipients per email.`, 400));

    const subject = String(req.body.subject || '').trim().slice(0, 250);
    const body = String(req.body.body || '').trim().slice(0, MAX_DRAFT);
    if (!subject) return next(new AppError('Add a subject.', 400));
    if (!body) return next(new AppError('The message is empty.', 400));

    const company = await Company.findById(req.companyId).select('companyName logo profile paymentSettings');
    const attachments = (req.files || []).map((f) => ({ filename: f.originalname, content: f.buffer }));
    if (req.params.type === 'invoice' && String(req.body.attachInvoicePdf) === 'true') {
      attachments.unshift({ filename: `Invoice-${doc.invoiceNumber}.pdf`, content: await renderInvoicePdf(doc, company) });
    }

    const html = emailService.baseTemplate(subject, textToHtml(body), {
      name: company?.companyName, logo: company?.logo, tagline: company?.profile?.tagline,
    });
    try {
      await emailService.sendEmail({
        to, cc, subject, html, text: body, attachments,
        // Replies go to the business, not to BizlyAI support.
        replyTo: company?.profile?.email || req.user.email,
      });
    } catch (e) {
      return next(new AppError(`Email could not be sent: ${e.response?.data?.message || e.message}`, 502));
    }

    // Keep the edited text, and record that it went out.
    saveDraftText(ctx, doc, `Subject: ${subject}\n\n${body}`);
    const preview = body.replace(/\s+/g, ' ').slice(0, 200);
    if (req.params.type === 'invoice') {
      doc.reminders.push({ sentAt: new Date(), method: 'email', aiGenerated: true, messagePreview: preview });
      if (!doc.sentAt) doc.sentAt = new Date();
      if (doc.status === 'draft') doc.status = 'sent';
    } else if (req.params.type === 'lead') {
      doc.activities.push({ type: 'email', description: `Emailed "${subject}" to ${to.join(', ')}`, performedBy: req.user._id });
      doc.lastContactedAt = new Date();
    }
    await doc.save();

    res.status(200).json({ success: true, data: { to, cc, attachments: attachments.map((a) => a.filename) } });
  } catch (err) { next(err); }
};
