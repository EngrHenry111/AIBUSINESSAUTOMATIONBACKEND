'use strict';

// Shared by the Laundry and Cleaning modules: numbering, money, payments,
// dates in Lagos time and the customer's "ready" email.

const SaleCounter = require('../models/SaleCounter');
const { AppError } = require('../middleware/errorMiddleware');

const MANAGERS = ['company_owner', 'manager', 'super_admin'];
const PAY_METHODS = ['cash', 'transfer', 'pos_terminal'];
const METHOD_LABEL = { cash: 'Cash', transfer: 'Transfer', pos_terminal: 'POS' };
const LAGOS_OFFSET = '+01:00';
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isManager = (user) => MANAGERS.includes(user?.role);
const lagosDate = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

// Start/end of a Lagos calendar day.
function lagosDay(dateStr) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : lagosDate();
  const start = new Date(`${day}T00:00:00${LAGOS_OFFSET}`);
  return { day, start, end: new Date(start.getTime() + DAY_MS) };
}

// A date `days` from now at `hour`:00 Lagos time.
function lagosAt(days, hour = 17) {
  const day = lagosDate(new Date(Date.now() + days * DAY_MS));
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00${LAGOS_OFFSET}`);
}

async function nextNumber(companyId, key, prefix, width = 5) {
  const c = await SaleCounter.findOneAndUpdate({ companyId, key }, { $inc: { seq: 1 } }, { upsert: true, new: true }).lean();
  return `${prefix}${String(c.seq).padStart(width, '0')}`;
}

function cleanCustomer(raw = {}, { requirePhone = false } = {}) {
  const customer = {
    name: String(raw.name || '').trim().slice(0, 120),
    phone: String(raw.phone || '').trim().slice(0, 30),
    email: String(raw.email || '').trim().toLowerCase().slice(0, 200),
  };
  if (!customer.name) throw new AppError('Add the customer\'s name.', 400);
  if (requirePhone && !customer.phone) throw new AppError('Add the customer\'s phone number so you can reach them.', 400);
  if (customer.email && !/^\S+@\S+\.\S+$/.test(customer.email)) throw new AppError('The customer email does not look right.', 400);
  return customer;
}

function cleanPayment(body = {}) {
  const amount = round2(body.amount);
  if (!(amount > 0)) throw new AppError('Enter the amount paid.', 400);
  if (!PAY_METHODS.includes(body.method)) throw new AppError('Choose how they paid: cash, transfer or POS.', 400);
  return { amount, method: body.method, note: String(body.note || '').trim().slice(0, 200) || undefined };
}

// Adds a payment without ever taking more than is owed, even when two
// people record one at the same moment. `totalPath` is where the record
// keeps its total ('total' or 'price.total').
async function addPayment(Model, { _id, companyId }, totalPath, payment, user) {
  const updated = await Model.findOneAndUpdate(
    {
      _id, companyId, status: { $ne: 'cancelled' },
      $expr: { $lte: [{ $add: ['$amountPaid', payment.amount] }, { $add: [`$${totalPath}`, 0.009] }] },
    },
    {
      $inc: { amountPaid: payment.amount },
      $push: {
        payments: { ...payment, at: new Date(), by: user._id, byName: user.name || '' },
        timeline: { status: 'payment', note: `${METHOD_LABEL[payment.method]} payment of ${payment.amount.toLocaleString('en-NG')}`, at: new Date(), byName: user.name || '' },
      },
    },
    { new: true },
  );
  if (updated) return updated;
  const current = await Model.findOne({ _id, companyId });
  if (!current) throw new AppError('Not found.', 404);
  if (current.status === 'cancelled') throw new AppError('This was cancelled, so no payment can be added.', 400);
  const total = totalPath === 'total' ? current.total : current.price.total;
  const owed = round2(total - current.amountPaid);
  throw new AppError(owed > 0 ? `That is more than the balance of ${owed.toLocaleString('en-NG')}.` : 'This is already fully paid.', 400);
}

// Plain-text and HTML email to a customer, from the business.
async function emailCustomer({ company, to, subject, lines }) {
  if (!to) return false;
  const { sendEmail } = require('../services/emailService');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827;max-width:520px">
    ${lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join('')}
    <p style="margin:16px 0 0;color:#64748b;font-size:13px">${esc(company?.companyName || '')}${company?.profile?.phone ? ` · ${esc(company.profile.phone)}` : ''}${company?.profile?.address ? `<br>${esc(company.profile.address)}` : ''}</p>
  </div>`;
  const r = await sendEmail({ to, subject, html, text: lines.join('\n\n'), replyTo: company?.profile?.email || undefined }).catch(() => null);
  return Boolean(r);
}

module.exports = {
  MANAGERS, PAY_METHODS, METHOD_LABEL, DAY_MS,
  round2, isManager, lagosDate, lagosDay, lagosAt, nextNumber, cleanCustomer, cleanPayment, addPayment, emailCustomer,
};
