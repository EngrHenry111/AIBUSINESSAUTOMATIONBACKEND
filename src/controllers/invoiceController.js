'use strict';

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const { generateStructured, runAgent } = require('../services/groqService');
const emailService = require('../services/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const { recordCustomerTransaction } = require('../utils/customerSync');
const { cleanAIText } = require('../utils/cleanAIText');
const logger = require('../utils/logger');

const clientUrl = () =>
  (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n, cur) => `${cur || 'USD'} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—');

// Fields needed anywhere a company's own branding/payment details show up
// on customer-facing output (invoice PDF, invoice/receipt emails, AI drafts).
const COMPANY_BRANDING_FIELDS = 'companyName logo website profile paymentSettings';

function bankDetailsBlock(company) {
  const ps = company?.paymentSettings;
  if (!ps?.isPaymentSetup) return null;
  return { bankName: ps.bankName, accountName: ps.accountName, accountNumber: ps.accountNumber };
}

exports.getInvoices = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;

    const [invoices, total, stats] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Invoice.countDocuments(filter),
      Invoice.aggregate([
        { $match: { companyId: req.companyId } },
        { $group: {
          _id: '$status',
          count: { $sum: 1 },
          total: { $sum: '$total' },
        }},
      ]),
    ]);

    res.status(200).json({ success: true, data: invoices, stats, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

exports.createInvoice = async (req, res, next) => {
  try {
    // Auto-generate invoice number
    const count = await Invoice.countDocuments({ companyId: req.companyId });
    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    const invoice = await Invoice.create({
      ...req.body,
      companyId: req.companyId,
      invoiceNumber,
      createdBy: req.user._id,
    });
    await recordCustomerTransaction({
      companyId: req.companyId, customer: invoice.customer, amount: invoice.total,
      countsAsOrder: false, date: invoice.issuedAt, userId: req.user._id,
    });

    require('../utils/cache').del(`dashboard_${req.companyId}`);
    res.status(201).json({ success: true, data: invoice });
  } catch (err) { next(err); }
};

exports.getInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!invoice) return next(new AppError('Invoice not found.', 404));
    res.status(200).json({ success: true, data: invoice });
  } catch (err) { next(err); }
};

exports.updateInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      req.body, { new: true, runValidators: true }
    );
    if (!invoice) return next(new AppError('Invoice not found.', 404));
    res.status(200).json({ success: true, data: invoice });
  } catch (err) { next(err); }
};

exports.draftReminder = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!invoice) return next(new AppError('Invoice not found.', 404));

    const company = await Company.findById(req.companyId).select(COMPANY_BRANDING_FIELDS);
    const bank = bankDetailsBlock(company);

    const daysOverdue = Math.floor((Date.now() - new Date(invoice.dueAt)) / (1000 * 60 * 60 * 24));
    const tone = daysOverdue <= 0 ? 'friendly reminder' : daysOverdue <= 14 ? 'firm but professional' : 'urgent and escalated';

    const prompt = `Draft a payment reminder email for an overdue invoice.

Invoice Details:
- Invoice Number: ${invoice.invoiceNumber}
- Customer: ${invoice.customer.name}
- Amount: ${invoice.total} ${invoice.currency}
- Due Date: ${new Date(invoice.dueAt).toDateString()}
- Days Overdue: ${daysOverdue > 0 ? daysOverdue : 'Not yet due'}
- Status: ${invoice.status}
- Sent from: ${company?.companyName || 'our business'}
${bank ? `
The business bank details are:
Bank: ${bank.bankName}
Account Name: ${bank.accountName}
Account Number: ${bank.accountNumber}

Include these payment details naturally in the reminder message so the customer knows exactly where to send payment. Reference the invoice number as the payment reference.` : ''}

Tone: ${tone}
Write a complete, professional email with subject line and body.`;

    const draft = cleanAIText(await runAgent('invoice_agent', prompt));

    invoice.ai = { ...invoice.ai, reminderDraft: draft };
    await invoice.save();

    res.status(200).json({ success: true, data: { draft, invoice } });
  } catch (err) { next(err); }
};

exports.getOverdueInvoices = async (req, res, next) => {
  try {
    const overdue = await Invoice.find({
      companyId: req.companyId,
      status: { $in: ['sent', 'viewed', 'partial'] },
      dueAt: { $lt: new Date() },
    }).sort({ dueAt: 1 });

    const totalOutstanding = overdue.reduce((sum, inv) => sum + inv.total, 0);
    res.status(200).json({ success: true, data: overdue, totalOutstanding });
  } catch (err) { next(err); }
};

exports.deleteInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!invoice) return next(new AppError('Invoice not found.', 404));
    res.status(200).json({ success: true, message: 'Invoice deleted.' });
  } catch (err) { next(err); }
};

// ── GET /invoices/:id/pdf — generate PDF
exports.generatePDF = async (req, res, next) => {
  try {
    const { AppError } = require('../middleware/errorMiddleware');
    const invoice = await require('../models/Invoice').findOne({
      _id: req.params.id,
      companyId: req.companyId,
    });
    if (!invoice) return next(new AppError('Invoice not found', 404));

    const company = await Company.findById(req.companyId).select(COMPANY_BRANDING_FIELDS);
    const profile = company?.profile || {};
    const bank = bankDetailsBlock(company);

    // Generate HTML invoice
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; gap: 20px; }
  .brand-row { display: flex; align-items: center; gap: 12px; }
  .brand-logo { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; }
  .brand { font-size: 22px; font-weight: 800; color: #6366f1; }
  .brand-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
  .brand-contact { font-size: 12px; color: #64748b; margin-top: 10px; line-height: 1.6; }
  .invoice-title { font-size: 32px; font-weight: 700; color: #6366f1; text-align: right; }
  .invoice-num { font-size: 14px; color: #64748b; text-align: right; margin-top: 4px; }
  .info-section { display: flex; justify-content: space-between; margin-bottom: 32px; }
  .info-block h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 8px; }
  .info-block p { font-size: 14px; color: #334155; line-height: 1.6; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase;
    background: ${invoice.status === 'paid' ? '#dcfce7' : invoice.status === 'overdue' ? '#fee2e2' : '#e0e7ff'};
    color: ${invoice.status === 'paid' ? '#166534' : invoice.status === 'overdue' ? '#991b1b' : '#3730a3'};
  }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: #f8fafc; padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; color: #64748b; }
  td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  .total-section { display: flex; justify-content: flex-end; }
  .total-box { width: 260px; }
  .total-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; color: #475569; border-bottom: 1px solid #f1f5f9; }
  .total-final { display: flex; justify-content: space-between; padding: 12px 0; font-size: 18px; font-weight: 700; color: #6366f1; border-top: 2px solid #6366f1; margin-top: 4px; }
  .notes { margin-top: 32px; padding: 16px; background: #f8fafc; border-radius: 8px; font-size: 13px; color: #475569; }
  .payment-box { margin-top: 24px; padding: 16px 20px; background: #f0f4ff; border: 1px solid #dbe3ff; border-radius: 8px; }
  .payment-box h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #4f46e5; margin-bottom: 8px; }
  .payment-box p { font-size: 14px; color: #334155; line-height: 1.7; }
  .footer { margin-top: 48px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  .footer .tagline { font-style: italic; margin-top: 4px; }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="brand-row">
      ${company?.logo ? `<img class="brand-logo" src="${company.logo}" alt="${esc(company.companyName)}"/>` : ''}
      <div>
        <div class="brand">${esc(company?.companyName || 'BizlyAI')}</div>
        ${profile.tagline ? `<div class="brand-sub">${esc(profile.tagline)}</div>` : ''}
      </div>
    </div>
    <div class="brand-contact">
      ${profile.address ? `${esc(profile.address)}<br/>` : ''}
      ${[profile.phone, profile.email].filter(Boolean).map(esc).join(' · ')}
      ${(profile.rcNumber || profile.tin) ? `<br/>${profile.rcNumber ? `RC: ${esc(profile.rcNumber)}` : ''}${profile.rcNumber && profile.tin ? ' · ' : ''}${profile.tin ? `TIN: ${esc(profile.tin)}` : ''}` : ''}
      ${company?.website ? `<br/>${esc(company.website)}` : ''}
    </div>
  </div>
  <div>
    <div class="invoice-title">INVOICE</div>
    <div class="invoice-num">${invoice.invoiceNumber}</div>
    <div style="margin-top:8px"><span class="status-badge">${invoice.status}</span></div>
  </div>
</div>

<div class="info-section">
  <div class="info-block">
    <h4>Bill To</h4>
    <p><strong>${invoice.customer?.name}</strong></p>
    ${invoice.customer?.email ? `<p>${invoice.customer.email}</p>` : ''}
    ${invoice.customer?.phone ? `<p>${invoice.customer.phone}</p>` : ''}
    ${invoice.customer?.address ? `<p>${invoice.customer.address}</p>` : ''}
  </div>
  <div class="info-block" style="text-align:right">
    <h4>Invoice Details</h4>
    <p>Issue Date: ${new Date(invoice.issuedAt || invoice.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
    <p>Due Date: ${new Date(invoice.dueAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
    ${invoice.paidAt ? `<p>Paid: ${new Date(invoice.paidAt).toLocaleDateString()}</p>` : ''}
  </div>
</div>

<table>
  <thead>
    <tr><th>Description</th><th>Qty</th><th>Unit Price</th><th style="text-align:right">Total</th></tr>
  </thead>
  <tbody>
    ${invoice.items?.map(item => `
      <tr>
        <td>${item.description}</td>
        <td>${item.quantity}</td>
        <td>${invoice.currency} ${Number(item.unitPrice).toLocaleString()}</td>
        <td style="text-align:right">${invoice.currency} ${Number(item.total).toLocaleString()}</td>
      </tr>
    `).join('') || ''}
  </tbody>
</table>

<div class="total-section">
  <div class="total-box">
    <div class="total-row"><span>Subtotal</span><span>${invoice.currency} ${Number(invoice.subtotal).toLocaleString()}</span></div>
    ${invoice.tax ? `<div class="total-row"><span>Tax</span><span>${invoice.currency} ${Number(invoice.tax).toLocaleString()}</span></div>` : ''}
    ${invoice.discount ? `<div class="total-row"><span>Discount</span><span>-${invoice.currency} ${Number(invoice.discount).toLocaleString()}</span></div>` : ''}
    <div class="total-final"><span>Total</span><span>${invoice.currency} ${Number(invoice.total).toLocaleString()}</span></div>
  </div>
</div>

${invoice.notes ? `<div class="notes"><strong>Notes:</strong> ${invoice.notes}</div>` : ''}

${bank ? `
<div class="payment-box">
  <h4>Payment Instructions</h4>
  <p>
    Bank Name: <strong>${esc(bank.bankName || '—')}</strong><br/>
    Account Name: <strong>${esc(bank.accountName || '—')}</strong><br/>
    Account Number: <strong>${esc(bank.accountNumber || '—')}</strong><br/>
    Reference: <strong>${esc(invoice.invoiceNumber)}</strong>
  </p>
</div>` : ''}

<div class="footer">
  Thank you for your business${company?.companyName ? ` — ${esc(company.companyName)}` : ''}.
  ${profile.tagline ? `<div class="tagline">${esc(profile.tagline)}</div>` : ''}
  <div style="margin-top:8px">Generated by BizlyAI · ${new Date().toLocaleDateString()}</div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoiceNumber}.html"`);
    res.send(html);
  } catch (err) { next(err); }
};

// ── Email HTML builders ─────────────────────────────────────────────────
function invoiceEmailHtml(invoice, company) {
  const cur = invoice.currency || 'USD';
  const profile = company?.profile || {};
  const bank = bankDetailsBlock(company);
  const portalUrl = `${clientUrl()}/portal/login?company=${invoice.companyId}`;
  const rows = (invoice.items || []).map((it) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;">${esc(it.description)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:center;">${esc(it.quantity ?? 1)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;">${money(it.unitPrice, cur)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;">${money(it.total, cur)}</td>
    </tr>`).join('');

  return `
    <h2 style="color:#0f172a;margin:0 0 4px;font-size:22px;">Invoice ${esc(invoice.invoiceNumber)}</h2>
    <p style="color:#64748b;margin:0 0 20px;font-size:14px;">From <strong>${esc(company?.companyName || 'BizlyAI')}</strong></p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr>
        <td style="font-size:13px;color:#475569;">Issue date: <strong>${day(invoice.issuedAt || invoice.createdAt)}</strong></td>
        <td style="font-size:13px;color:#475569;text-align:right;">Due date: <strong>${day(invoice.dueAt)}</strong></td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin:0 0 8px;">
      <tr style="background:#f8fafc;">
        <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Description</th>
        <th style="padding:10px 12px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Qty</th>
        <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Unit</th>
        <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Total</th>
      </tr>
      ${rows || '<tr><td colspan="4" style="padding:14px;color:#94a3b8;font-size:13px;">No line items</td></tr>'}
    </table>

    <table width="260" cellpadding="0" cellspacing="0" align="right" style="margin:0 0 24px;">
      <tr><td style="padding:6px 0;font-size:14px;color:#475569;">Subtotal</td><td style="padding:6px 0;font-size:14px;color:#475569;text-align:right;">${money(invoice.subtotal, cur)}</td></tr>
      ${invoice.tax ? `<tr><td style="padding:6px 0;font-size:14px;color:#475569;">Tax</td><td style="padding:6px 0;font-size:14px;color:#475569;text-align:right;">${money(invoice.tax, cur)}</td></tr>` : ''}
      ${invoice.discount ? `<tr><td style="padding:6px 0;font-size:14px;color:#475569;">Discount</td><td style="padding:6px 0;font-size:14px;color:#475569;text-align:right;">-${money(invoice.discount, cur)}</td></tr>` : ''}
      <tr><td style="padding:12px 0 0;font-size:17px;font-weight:800;color:#6366f1;border-top:2px solid #6366f1;">TOTAL</td><td style="padding:12px 0 0;font-size:17px;font-weight:800;color:#6366f1;border-top:2px solid #6366f1;text-align:right;">${money(invoice.total, cur)}</td></tr>
    </table>

    <div style="clear:both;text-align:center;margin:8px 0 24px;">
      <a href="${portalUrl}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        View Invoice &amp; Pay
      </a>
    </div>

    ${invoice.notes ? `<p style="font-size:13px;color:#475569;background:#f8fafc;border-radius:8px;padding:12px;">${esc(invoice.notes)}</p>` : ''}

    ${bank ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border:1px solid #dbe3ff;border-radius:10px;margin:0 0 20px;">
      <tr><td style="padding:16px 20px;">
        <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#4f46e5;font-weight:700;margin:0 0 8px;">Payment Instructions</p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0;">
          Bank Name: <strong>${esc(bank.bankName || '—')}</strong><br/>
          Account Name: <strong>${esc(bank.accountName || '—')}</strong><br/>
          Account Number: <strong>${esc(bank.accountNumber || '—')}</strong><br/>
          Reference: <strong>${esc(invoice.invoiceNumber)}</strong>
        </p>
      </td></tr>
    </table>` : ''}

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;margin:0;">
      ${esc(company?.companyName || 'BizlyAI')}${company?.website ? ` · <a href="${esc(company.website)}" style="color:#6366f1;">${esc(company.website)}</a>` : ''}
      ${[profile.phone, profile.email].filter(Boolean).length ? `<br/>${[profile.phone, profile.email].filter(Boolean).map(esc).join(' · ')}` : ''}
      ${profile.address ? `<br/>${esc(profile.address)}` : ''}<br/>
      Questions about this invoice? Just reply to this email.
    </p>`;
}

function receiptEmailHtml(invoice, company) {
  const cur = invoice.currency || 'USD';
  const portalUrl = `${clientUrl()}/portal/login?company=${invoice.companyId}`;
  return `
    <div style="text-align:center;margin:0 0 8px;">
      <div style="width:56px;height:56px;border-radius:50%;background:#dcfce7;color:#16a34a;font-size:30px;line-height:56px;margin:0 auto 12px;">✅</div>
    </div>
    <h2 style="color:#0f172a;margin:0 0 6px;font-size:22px;text-align:center;">Payment Received</h2>
    <p style="color:#64748b;margin:0 0 24px;font-size:14px;text-align:center;">Thank you for your payment to <strong>${esc(company?.companyName || 'BizlyAI')}</strong>.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;padding:4px 0;margin:0 0 24px;">
      <tr><td style="padding:10px 16px;font-size:13px;color:#475569;">Invoice</td><td style="padding:10px 16px;font-size:13px;color:#0f172a;font-weight:600;text-align:right;">${esc(invoice.invoiceNumber)}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;color:#475569;">Payment date</td><td style="padding:10px 16px;font-size:13px;color:#0f172a;font-weight:600;text-align:right;">${day(invoice.paidAt || new Date())}</td></tr>
      <tr><td style="padding:10px 16px;font-size:13px;color:#475569;">Amount paid</td><td style="padding:10px 16px;font-size:16px;color:#16a34a;font-weight:800;text-align:right;">${money(invoice.total, cur)}</td></tr>
    </table>

    <div style="text-align:center;margin:0 0 24px;">
      <a href="${portalUrl}" style="background:#6366f1;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
        Download Receipt
      </a>
    </div>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;">
      ${esc(company?.companyName || 'BizlyAI')} · This is your official payment confirmation.
    </p>`;
}

// ── POST /invoices/:id/send-email ───────────────────────────────────────
// Fire-and-forget: the HTTP response never waits on the SMTP round-trip to
// Resend, which is what was causing "Request timeout, try again" on the
// frontend. The invoice is marked sent immediately; the actual email goes
// out right after, and any failure is logged (not surfaced as a failed
// request, since the user already got a success response).
exports.sendInvoiceEmail = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!invoice) return next(new AppError('Invoice not found.', 404));
    if (!invoice.customer?.email) {
      return next(new AppError('This invoice has no customer email address.', 400));
    }

    const company = await Company.findById(req.companyId).select(COMPANY_BRANDING_FIELDS);
    const html = emailService.baseTemplate(
      `Invoice ${invoice.invoiceNumber}`,
      invoiceEmailHtml(invoice, company),
      { name: company?.companyName, logo: company?.logo, tagline: company?.profile?.tagline },
    );

    invoice.sentAt = new Date();
    if (invoice.status === 'draft') invoice.status = 'sent';
    invoice.reminders.push({ sentAt: new Date(), method: 'email', aiGenerated: false, messagePreview: 'Invoice sent to customer' });
    await invoice.save();

    // Not awaited on purpose — see comment above.
    emailService.send({
      to: invoice.customer.email,
      subject: `Invoice ${invoice.invoiceNumber} from ${company?.companyName || 'BizlyAI'}`,
      html,
    })
      .then(() => logger.info(`Invoice ${invoice.invoiceNumber} emailed to ${invoice.customer.email}`))
      .catch((err) => logger.error(`Invoice email failed for ${invoice.invoiceNumber}: ${err.message}`));

    res.status(200).json({ success: true, message: `Invoice sent to ${invoice.customer.email}`, data: invoice });
  } catch (err) {
    logger.error(`sendInvoiceEmail failed: ${err.message}`);
    next(new AppError('Could not queue the invoice email. Please try again.', 502));
  }
};

// ── POST /invoices/:id/send-receipt ─────────────────────────────────────
exports.sendPaymentReceipt = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!invoice) return next(new AppError('Invoice not found.', 404));
    if (invoice.status !== 'paid') {
      return next(new AppError('A receipt can only be sent for a paid invoice.', 400));
    }
    if (!invoice.customer?.email) {
      return next(new AppError('This invoice has no customer email address.', 400));
    }

    const company = await Company.findById(req.companyId).select(COMPANY_BRANDING_FIELDS);
    const html = emailService.baseTemplate(
      'Payment Received',
      receiptEmailHtml(invoice, company),
      { name: company?.companyName, logo: company?.logo, tagline: company?.profile?.tagline },
    );

    invoice.receiptSentAt = new Date();
    await invoice.save();

    // Not awaited — see sendInvoiceEmail above for why.
    emailService.send({
      to: invoice.customer.email,
      subject: `Payment received — Invoice ${invoice.invoiceNumber}`,
      html,
    })
      .then(() => logger.info(`Receipt for ${invoice.invoiceNumber} emailed to ${invoice.customer.email}`))
      .catch((err) => logger.error(`Receipt email failed for ${invoice.invoiceNumber}: ${err.message}`));

    res.status(200).json({ success: true, message: `Receipt sent to ${invoice.customer.email}`, data: invoice });
  } catch (err) {
    logger.error(`sendPaymentReceipt failed: ${err.message}`);
    next(new AppError('Could not queue the receipt email. Please try again.', 502));
  }
};