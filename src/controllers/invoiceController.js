'use strict';

const Invoice = require('../models/Invoice');
const { generateStructured, runAgent } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');

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

Tone: ${tone}
Write a complete, professional email with subject line and body.`;

    const draft = await runAgent('invoice_agent', prompt);

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

    const company = await require('../models/Company').findById(req.companyId);

    // Generate HTML invoice
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 40px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 40px; }
  .brand { font-size: 24px; font-weight: 800; color: #6366f1; }
  .brand-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
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
  .footer { margin-top: 48px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="brand">EngrHenryTech BusinessAI</div>
    <div class="brand-sub">${company?.companyName || ''}</div>
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

<div class="footer">
  Generated by EngrHenryTech BusinessAI · ${new Date().toLocaleDateString()}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoiceNumber}.html"`);
    res.send(html);
  } catch (err) { next(err); }
};