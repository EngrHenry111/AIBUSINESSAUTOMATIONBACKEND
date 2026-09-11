'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const PortalToken = require('../models/PortalToken');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Appointment = require('../models/Appointment');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');

const PORTAL_JWT_TTL = '24h';
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const clientUrl = () =>
  (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

function signPortalJwt(email, companyId) {
  return jwt.sign(
    { portal: true, email, companyId: String(companyId) },
    process.env.JWT_SECRET,
    { expiresIn: PORTAL_JWT_TTL }
  );
}

// Portal JWT comes from the Authorization header, or a ?token= query param for
// direct browser navigations (e.g. opening an invoice PDF in a new tab).
function readPortalJwt(req) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  if (!raw) throw new AppError('Portal access token required.', 401);
  let decoded;
  try {
    decoded = jwt.verify(raw, process.env.JWT_SECRET);
  } catch {
    throw new AppError('Your portal session has expired. Please request a new link.', 401);
  }
  if (!decoded || decoded.portal !== true || !decoded.email || !decoded.companyId) {
    throw new AppError('Invalid portal token.', 401);
  }
  return decoded;
}

// ── POST /portal/request ─────────────────────────────────────────────────
exports.requestAccess = async (req, res, next) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const { companyId } = req.body;

    if (!email || !companyId) return next(new AppError('Email and company are required.', 400));
    if (!mongoose.isValidObjectId(companyId)) return next(new AppError('Invalid company.', 400));

    const [company, invCount, ordCount, apptCount] = await Promise.all([
      Company.findById(companyId).select('companyName'),
      Invoice.countDocuments({ companyId, 'customer.email': email }),
      Order.countDocuments({ companyId, 'customer.email': email }),
      Appointment.countDocuments({ companyId, 'customer.email': email }),
    ]);

    if (!company) return next(new AppError('Company not found.', 404));

    if (invCount + ordCount + apptCount === 0) {
      return next(new AppError('No records found for this email address.', 404));
    }

    const token = crypto.randomBytes(32).toString('hex');
    await PortalToken.create({
      email,
      companyId,
      token,
      expiresAt: new Date(Date.now() + LINK_TTL_MS),
    });

    const link = `${clientUrl()}/portal?token=${token}`;
    logger.info(`🔗 Portal access link for ${email}: ${link}`);
    emailService.sendPortalLink(email, company.companyName, link).catch((err) =>
      logger.warn(`Portal link email failed for ${email}: ${err.message}`)
    );

    res.status(200).json({ success: true, message: 'Check your email for an access link.' });
  } catch (err) { next(err); }
};

// ── GET /portal/verify?token=xxx ─────────────────────────────────────────
exports.verifyToken = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return next(new AppError('Token is required.', 400));

    const record = await PortalToken.findOne({
      token,
      used: false,
      expiresAt: { $gt: new Date() },
    });
    if (!record) return next(new AppError('This link is invalid or has expired. Please request a new one.', 400));

    record.used = true;
    await record.save();

    res.status(200).json({
      success: true,
      token: signPortalJwt(record.email, record.companyId),
      email: record.email,
    });
  } catch (err) { next(err); }
};

// ── GET /portal/data ────────────────────────────────────────────────────
exports.getPortalData = async (req, res, next) => {
  try {
    const { email, companyId } = readPortalJwt(req);

    const [company, invoices, orders, appointments] = await Promise.all([
      Company.findById(companyId).select('companyName logo website profile paymentSettings').lean(),
      Invoice.find({ companyId, 'customer.email': email }).sort({ createdAt: -1 }).lean(),
      Order.find({ companyId, 'customer.email': email }).sort({ createdAt: -1 }).lean(),
      Appointment.find({ companyId, 'customer.email': email }).sort({ scheduledAt: -1 }).lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        email,
        // Business identity + manual-payment bank details for this portal.
        company: {
          name: company?.companyName || 'Your provider',
          logo: company?.logo || null,
          website: company?.website || null,
          tagline: company?.profile?.tagline || null,
          contact: {
            email: company?.profile?.email || null,
            phone: company?.profile?.phone || null,
            address: company?.profile?.address || null,
          },
          bankDetails: company?.paymentSettings?.isPaymentSetup ? {
            bankName: company.paymentSettings.bankName,
            accountName: company.paymentSettings.accountName,
            accountNumber: company.paymentSettings.accountNumber,
          } : null,
        },
        invoices: invoices.map((i) => ({
          _id: i._id,
          invoiceNumber: i.invoiceNumber,
          total: i.total,
          currency: i.currency || 'USD',
          status: i.status,
          issuedAt: i.issuedAt || i.createdAt,
          dueAt: i.dueAt,
          paidAt: i.paidAt || null,
        })),
        orders: orders.map((o) => ({
          _id: o._id,
          orderNumber: o.orderNumber,
          total: o.total,
          currency: o.currency || 'USD',
          status: o.status,
          itemsCount: (o.items || []).length,
          createdAt: o.createdAt,
          trackingNumber: o.trackingNumber || null,
        })),
        appointments: appointments.map((a) => ({
          _id: a._id,
          title: a.title,
          scheduledAt: a.scheduledAt,
          duration: a.duration,
          status: a.status,
          location: a.location || null,
          isVirtual: !!a.isVirtual,
          meetingLink: a.meetingLink || null,
        })),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /portal/invoices/:id/pdf?token=xxx ───────────────────────────────
exports.getInvoicePdf = async (req, res, next) => {
  try {
    const { email, companyId } = readPortalJwt(req);
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Invoice not found.', 404));

    const [invoice, company] = await Promise.all([
      Invoice.findOne({ _id: req.params.id, companyId, 'customer.email': email }).lean(),
      Company.findById(companyId).select('companyName').lean(),
    ]);
    if (!invoice) return next(new AppError('Invoice not found.', 404));

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoiceNumber}.html"`);
    res.send(renderInvoiceHtml(invoice, company));
  } catch (err) { next(err); }
};

// ── Helpers ─────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n, cur) => `${cur || 'USD'} ${Number(n || 0).toLocaleString()}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—');

function renderInvoiceHtml(inv, company) {
  const rows = (inv.items || []).map((it) => `
    <tr>
      <td>${esc(it.description)}</td>
      <td style="text-align:center">${esc(it.quantity ?? 1)}</td>
      <td style="text-align:right">${money(it.unitPrice, inv.currency)}</td>
      <td style="text-align:right">${money(it.total, inv.currency)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Invoice ${esc(inv.invoiceNumber)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1e293b;padding:40px;max-width:800px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px}
  .brand{font-size:22px;font-weight:800;color:#6366f1}
  .brand small{display:block;font-size:12px;color:#64748b;font-weight:500;margin-top:2px}
  .doc-title{font-size:30px;font-weight:800;color:#6366f1;text-align:right}
  .doc-num{font-size:13px;color:#64748b;text-align:right;margin-top:4px}
  .badge{display:inline-block;margin-top:8px;padding:3px 12px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;
    background:${inv.status === 'paid' ? '#dcfce7' : inv.status === 'overdue' ? '#fee2e2' : '#e0e7ff'};
    color:${inv.status === 'paid' ? '#166534' : inv.status === 'overdue' ? '#991b1b' : '#3730a3'}}
  .cols{display:flex;justify-content:space-between;gap:24px;margin-bottom:28px}
  .cols h4{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-bottom:6px}
  .cols p{font-size:13px;color:#334155;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  th{background:#f8fafc;padding:10px 14px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b}
  td{padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px}
  .totals{margin-left:auto;width:260px}
  .totals .row{display:flex;justify-content:space-between;padding:7px 0;font-size:13px;color:#475569}
  .totals .final{display:flex;justify-content:space-between;padding:12px 0;font-size:17px;font-weight:800;color:#6366f1;border-top:2px solid #6366f1;margin-top:4px}
  .notes{margin-top:28px;padding:14px;background:#f8fafc;border-radius:8px;font-size:12px;color:#475569}
  .foot{margin-top:44px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:14px}
  @media print{body{padding:0}}
</style></head><body>
<div class="top">
  <div class="brand">${esc(company?.companyName || 'BizlyAI')}<small>Powered by BizlyAI</small></div>
  <div>
    <div class="doc-title">INVOICE</div>
    <div class="doc-num">${esc(inv.invoiceNumber)}</div>
    <div><span class="badge">${esc(inv.status)}</span></div>
  </div>
</div>
<div class="cols">
  <div>
    <h4>Bill To</h4>
    <p><strong>${esc(inv.customer?.name)}</strong></p>
    ${inv.customer?.email ? `<p>${esc(inv.customer.email)}</p>` : ''}
    ${inv.customer?.phone ? `<p>${esc(inv.customer.phone)}</p>` : ''}
    ${inv.customer?.address ? `<p>${esc(inv.customer.address)}</p>` : ''}
  </div>
  <div style="text-align:right">
    <h4>Details</h4>
    <p>Issued: ${day(inv.issuedAt || inv.createdAt)}</p>
    <p>Due: ${day(inv.dueAt)}</p>
    ${inv.paidAt ? `<p>Paid: ${day(inv.paidAt)}</p>` : ''}
  </div>
</div>
<table>
  <thead><tr><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Total</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" style="color:#94a3b8">No line items</td></tr>'}</tbody>
</table>
<div class="totals">
  <div class="row"><span>Subtotal</span><span>${money(inv.subtotal, inv.currency)}</span></div>
  ${inv.tax ? `<div class="row"><span>Tax</span><span>${money(inv.tax, inv.currency)}</span></div>` : ''}
  ${inv.discount ? `<div class="row"><span>Discount</span><span>-${money(inv.discount, inv.currency)}</span></div>` : ''}
  <div class="final"><span>Total</span><span>${money(inv.total, inv.currency)}</span></div>
</div>
${inv.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(inv.notes)}</div>` : ''}
<div class="foot">Generated ${day(new Date())} · BizlyAI customer portal</div>
</body></html>`;
}
