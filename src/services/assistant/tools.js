'use strict';

// The business assistant's tools. Two kinds:
//   read   — run straight away inside a turn, always scoped to ctx.companyId.
//   action — never run inside a turn. prepare() checks everything and turns
//            the request into a plain-language card; execute() runs only when
//            the person approves that card, and re-checks first, because the
//            data may have changed in between (an invoice paid meanwhile).
// Each action goes through the same shared code as the app's own buttons.

const mongoose = require('mongoose');
const Invoice = require('../../models/Invoice');
const Lead = require('../../models/Lead');
const Customer = require('../../models/Customer');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Appointment = require('../../models/Appointment');
const Expense = require('../../models/Expense');
const emailService = require('../emailService');
const { AppError } = require('../../middleware/errorMiddleware');
const { balanceOf, moneyOf, canPayOnline, payLink } = require('../../utils/invoicePayments');
const { remind, MIN_GAP_MS } = require('../../utils/invoiceReminders');

const DAY_MS = 24 * 60 * 60 * 1000;
const UNPAID = ['sent', 'viewed', 'partial', 'overdue'];
const OPEN_LEAD = { $nin: ['won', 'lost', 'converted'] };
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'converted'];
const MAX_BATCH = 25;

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Models like typographic dashes (INV‑2026‑0011 with U+2011); records use "-".
const plain = (s) => String(s ?? '').replace(/[‐-―−]/g, '-').trim();
const rx = (s) => new RegExp(escRx(plain(s).slice(0, 80)), 'i');
const limitOf = (n, d = 20, max = 50) => Math.min(max, Math.max(1, Math.floor(Number(n)) || d));
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const niceDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
const daysSince = (d, now = Date.now()) => Math.floor((now - new Date(d)) / DAY_MS);
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };
const fail = (msg) => { throw new AppError(msg, 400); };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// YYYY-MM-DD as a Lagos calendar day. endOfDay for due dates.
function parseDay(s, { endOfDay = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T${endOfDay ? '23:59:59' : '12:00:00'}+01:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function smsOn(company) {
  return process.env.SMS_ENABLED === 'true' && company?.smsSettings?.enabled !== false && company?.smsSettings?.sendInvoiceSMS !== false;
}

function sumByCurrency(rows, valueOf) {
  const out = {};
  for (const r of rows) {
    const cur = r.currency || 'NGN';
    out[cur] = (out[cur] || 0) + valueOf(r);
  }
  return Object.entries(out).filter(([, v]) => v > 0).map(([cur, v]) => moneyOf(v, cur)).join(' + ') || moneyOf(0, 'NGN');
}

// "Invoice sent to customer" entries share the reminders array.
const remindersSent = (inv) => (inv.reminders || []).filter((r) => !/^Invoice sent/.test(r.messagePreview || ''));

function invoiceRow(inv, now = Date.now()) {
  const balance = balanceOf(inv);
  const overdueBy = inv.dueAt && UNPAID.includes(inv.status) ? daysSince(inv.dueAt, now) : 0;
  const sent = remindersSent(inv);
  // No database id: the model refers to invoices by number, which it copies
  // reliably across turns where a 24-character id gets garbled.
  return {
    number: inv.invoiceNumber,
    customer: inv.customer?.name,
    hasEmail: Boolean(inv.customer?.email),
    hasPhone: Boolean(inv.customer?.phone),
    status: inv.status,
    total: moneyOf(inv.total, inv.currency),
    balanceDue: moneyOf(balance, inv.currency),
    balance,
    currency: inv.currency || 'NGN',
    dueDate: isoDay(inv.dueAt),
    ...(overdueBy > 0 && { daysOverdue: overdueBy }),
    remindersSent: sent.length,
    ...(sent.length && { lastReminder: isoDay(sent[sent.length - 1].sentAt) }),
    ...(inv.remindersPaused && { autoRemindersPaused: true }),
    ...(inv.orderId && { storeOrder: inv.orderNumber || true }),
  };
}

async function findInvoiceRef(ref, ctx, select) {
  const value = plain(ref).slice(0, 60);
  if (!value) fail('Say which invoice.');
  const filter = mongoose.isValidObjectId(value)
    ? { _id: value, companyId: ctx.companyId }
    : { invoiceNumber: new RegExp(`^${escRx(value)}$`, 'i'), companyId: ctx.companyId };
  const q = Invoice.findOne(filter);
  const inv = await (select ? q.select(select) : q);
  if (!inv) fail(`No invoice found for "${value}". Look it up with find_invoices first.`);
  return inv;
}

// Why an invoice can't get a reminder right now, or null if it can.
function reminderBlocker(inv, company, now) {
  if (inv.status === 'draft') return 'still a draft, never sent to the customer';
  if (inv.status === 'cancelled') return 'cancelled';
  if (balanceOf(inv) <= 0) return 'already paid';
  if (inv.orderId) return 'belongs to a store order, which collects its own payment';
  if (!inv.customer?.email && !(inv.customer?.phone && smsOn(company))) {
    return inv.customer?.phone ? 'no email address, and SMS is switched off' : 'no email address or phone number';
  }
  if (!inv.dueAt || now - new Date(inv.dueAt) < DAY_MS) return `not overdue yet (due ${niceDay(inv.dueAt)})`;
  const last = inv.reminders?.[inv.reminders.length - 1];
  if (last?.sentAt && now - new Date(last.sentAt) < MIN_GAP_MS) return 'already reminded in the last day';
  return null;
}

const channelsFor = (inv, company) => [inv.customer?.email && 'email', inv.customer?.phone && smsOn(company) && 'SMS'].filter(Boolean).join(' + ');

async function findLeadRef(ref, ctx) {
  const value = plain(ref).slice(0, 120);
  if (!value) fail('Say which lead.');
  if (mongoose.isValidObjectId(value)) {
    const lead = await Lead.findOne({ _id: value, companyId: ctx.companyId });
    if (lead) return lead;
  }
  const matches = await Lead.find({ companyId: ctx.companyId, name: new RegExp(`^${escRx(value)}$`, 'i') }).limit(2);
  if (matches.length === 1) return matches[0];
  fail(matches.length ? `More than one lead is called "${value}". Use find_leads and pick one by id.` : `No lead found for "${value}". Use find_leads first.`);
}

// ─── Read tools ─────────────────────────────────────────────────────────────

const business_snapshot = {
  kind: 'read',
  label: 'Checked the business overview',
  description: 'Overview of the business right now: money owed on invoices (and how much is overdue), invoice payments and store sales this month, open orders, leads needing follow-up, low-stock products, upcoming appointments and this month\'s expenses. Start here for "how is my business doing" questions.',
  parameters: { type: 'object', properties: {} },
  async run(args, ctx) {
    const now = new Date();
    const start = monthStart();
    const cid = ctx.companyId;
    const [unpaid, paidThisMonth, orders, openOrders, newLeads, dueFollowUps, lowStock, appointments, expenses] = await Promise.all([
      Invoice.find({ companyId: cid, status: { $in: UNPAID } }).select('status total amountPaid currency dueAt').lean(),
      Invoice.find({ companyId: cid, status: 'paid', paidAt: { $gte: start }, orderId: null }).select('total currency').lean(),
      Order.find({ companyId: cid, createdAt: { $gte: start }, status: { $nin: ['cancelled', 'refunded'] } }).select('total currency paymentStatus').lean(),
      Order.countDocuments({ companyId: cid, status: { $in: ['pending', 'confirmed', 'processing'] } }),
      Lead.countDocuments({ companyId: cid, createdAt: { $gte: new Date(now - 7 * DAY_MS) } }),
      Lead.countDocuments({ companyId: cid, status: OPEN_LEAD, nextFollowUpAt: { $lte: now } }),
      Product.countDocuments({ companyId: cid, status: { $ne: 'inactive' }, 'stock.trackStock': { $ne: false }, $expr: { $lte: ['$stock.quantity', { $ifNull: ['$stock.lowStockThreshold', 5] }] } }),
      Appointment.countDocuments({ companyId: cid, scheduledAt: { $gte: now, $lte: new Date(+now + 7 * DAY_MS) }, status: { $in: ['pending', 'confirmed', 'rescheduled'] } }),
      Expense.find({ companyId: cid, date: { $gte: start }, status: { $ne: 'rejected' } }).select('amount currency').lean(),
    ]);
    const overdue = unpaid.filter((i) => i.dueAt && new Date(i.dueAt) < now);
    const paidOrders = orders.filter((o) => o.paymentStatus === 'paid');
    return {
      today: isoDay(now),
      invoices: {
        unpaidCount: unpaid.length,
        owedToYou: sumByCurrency(unpaid, balanceOf),
        overdueCount: overdue.length,
        overdueAmount: sumByCurrency(overdue, balanceOf),
        paidThisMonthCount: paidThisMonth.length,
        paidThisMonth: sumByCurrency(paidThisMonth, (i) => i.total || 0),
      },
      storeOrders: {
        thisMonthCount: orders.length,
        paidSalesThisMonth: sumByCurrency(paidOrders, (o) => o.total || 0),
        openOrders,
      },
      leads: { newLast7Days: newLeads, followUpsDue: dueFollowUps },
      productsLowOnStock: lowStock,
      appointmentsNext7Days: appointments,
      expensesThisMonth: sumByCurrency(expenses, (e) => e.amount || 0),
    };
  },
};

const find_invoices = {
  kind: 'read',
  label: 'Looked through invoices',
  description: 'Find invoices. status "unpaid" (default) = sent but not fully paid; "overdue" = unpaid and past the due date. Filter by customer, by the balance still owed, or by how long overdue. Returns each invoice\'s id, balance and reminder history.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['unpaid', 'overdue', 'draft', 'paid', 'partial', 'cancelled', 'any'] },
      customer: { type: 'string', description: 'Part of the customer name, email or phone' },
      minBalance: { type: 'number', description: 'Only invoices owing at least this much' },
      maxBalance: { type: 'number' },
      minDaysOverdue: { type: 'integer' },
      limit: { type: 'integer', description: 'Default 20, max 50' },
    },
  },
  async run(a, ctx) {
    const now = Date.now();
    const filter = { companyId: ctx.companyId };
    const status = a.status || 'unpaid';
    if (status === 'unpaid' || status === 'overdue') filter.status = { $in: UNPAID };
    else if (status !== 'any') filter.status = status;
    if (status === 'overdue' || a.minDaysOverdue > 0) {
      filter.status = { $in: UNPAID };
      filter.dueAt = { $lt: new Date(now - Math.max(0, Number(a.minDaysOverdue) || 0) * DAY_MS) };
    }
    if (a.customer) filter.$or = [{ 'customer.name': rx(a.customer) }, { 'customer.email': rx(a.customer) }, { 'customer.phone': rx(a.customer) }];

    const rows = await Invoice.find(filter).sort({ dueAt: 1 }).limit(1000)
      .select('invoiceNumber customer status total amountPaid currency dueAt reminders remindersPaused orderId orderNumber').lean();
    const min = Number(a.minBalance) || 0;
    const max = a.maxBalance > 0 ? Number(a.maxBalance) : Infinity;
    const matched = rows.filter((inv) => {
      const b = balanceOf(inv);
      return (min <= 0 || b >= min) && b <= max;
    });
    const limit = limitOf(a.limit);
    return {
      matched: matched.length,
      ...(status !== 'paid' && status !== 'cancelled' && { totalStillOwed: sumByCurrency(matched, balanceOf) }),
      invoices: matched.slice(0, limit).map((inv) => invoiceRow(inv, now)),
      ...(matched.length > limit && { note: `Showing ${limit} of ${matched.length}.` }),
    };
  },
};

const get_invoice = {
  kind: 'read',
  label: 'Opened an invoice',
  description: 'Full details of one invoice by number (e.g. INV-2026-0011): items, payments, reminders and the customer\'s pay link.',
  parameters: { type: 'object', properties: { invoice: { type: 'string' } }, required: ['invoice'] },
  async run(a, ctx) {
    const inv = await findInvoiceRef(a.invoice, ctx);
    const url = balanceOf(inv) > 0 && inv.status !== 'draft' && canPayOnline(ctx.company, inv) ? await payLink(inv) : null;
    return {
      ...invoiceRow(inv),
      customer: { name: inv.customer?.name, email: inv.customer?.email, phone: inv.customer?.phone },
      issued: isoDay(inv.issuedAt),
      items: (inv.items || []).map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: moneyOf(i.unitPrice, inv.currency) })),
      paid: moneyOf(inv.amountPaid || 0, inv.currency),
      payments: (inv.payments || []).map((p) => ({ amount: moneyOf(p.amount, inv.currency), method: p.method, on: isoDay(p.paidAt) })),
      reminders: remindersSent(inv).slice(-5).map((r) => ({ on: isoDay(r.sentAt), by: r.method, auto: Boolean(r.auto) })),
      notes: inv.notes || undefined,
      payLink: url || (inv.status === 'draft' ? 'Not sent yet, so there is no pay link.' : 'Online payment is not set up; the customer pays by bank transfer.'),
    };
  },
};

const find_leads = {
  kind: 'read',
  label: 'Looked through leads',
  description: 'Find sales leads. By default only open leads (not won, lost or converted). Use followUpDue for leads whose follow-up date has come, or notContactedForDays for leads going cold.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...LEAD_STATUSES, 'open', 'any'] },
      search: { type: 'string', description: 'Part of the name, email, phone or company' },
      followUpDue: { type: 'boolean' },
      notContactedForDays: { type: 'integer', description: 'Going cold: about 14' },
      minScore: { type: 'integer', description: '0 to 100. Hot: about 70' },
      limit: { type: 'integer' },
    },
  },
  async run(a, ctx) {
    const now = Date.now();
    const filter = { companyId: ctx.companyId };
    const status = a.status || 'open';
    if (status === 'open') filter.status = OPEN_LEAD;
    else if (status !== 'any') filter.status = status;
    const and = [];
    if (a.search) and.push({ $or: ['name', 'email', 'phone', 'company'].map((f) => ({ [f]: rx(a.search) })) });
    if (a.followUpDue) filter.nextFollowUpAt = { $lte: new Date(now) };
    if (a.notContactedForDays > 0) {
      const cutoff = new Date(now - a.notContactedForDays * DAY_MS);
      and.push({ $or: [{ lastContactedAt: { $lt: cutoff } }, { lastContactedAt: null, createdAt: { $lt: cutoff } }] });
    }
    if (a.minScore > 0) filter.score = { $gte: Number(a.minScore) };
    if (and.length) filter.$and = and;

    const limit = limitOf(a.limit);
    const [leads, matched] = await Promise.all([
      Lead.find(filter).sort({ score: -1, updatedAt: -1 }).limit(limit)
        .select('name email phone company status score value currency source lastContactedAt nextFollowUpAt ai.priority ai.recommendedAction createdAt').lean(),
      Lead.countDocuments(filter),
    ]);
    return {
      matched,
      leads: leads.map((l) => ({
        id: String(l._id), name: l.name, company: l.company || undefined,
        email: l.email || undefined, phone: l.phone || undefined,
        status: l.status, score: l.score,
        ...(l.value > 0 && { value: moneyOf(l.value, l.currency) }),
        source: l.source,
        lastContacted: isoDay(l.lastContactedAt) || 'never',
        nextFollowUp: isoDay(l.nextFollowUpAt) || undefined,
        priority: l.ai?.priority, suggestedNextStep: l.ai?.recommendedAction,
        added: isoDay(l.createdAt),
      })),
    };
  },
};

const find_customers = {
  kind: 'read',
  label: 'Looked through customers',
  description: 'Find customers. sortBy "topSpenders" (default), "recent", or use inactiveForDays for customers who haven\'t bought in a while.',
  parameters: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Part of the name, email or phone' },
      sortBy: { type: 'string', enum: ['topSpenders', 'recent'] },
      inactiveForDays: { type: 'integer' },
      limit: { type: 'integer' },
    },
  },
  async run(a, ctx) {
    const filter = { companyId: ctx.companyId };
    if (a.search) filter.$or = ['name', 'email', 'phone', 'company'].map((f) => ({ [f]: rx(a.search) }));
    if (a.inactiveForDays > 0) filter.lastOrderAt = { $lt: new Date(Date.now() - a.inactiveForDays * DAY_MS) };
    const sort = a.sortBy === 'recent' ? { lastOrderAt: -1, createdAt: -1 } : { totalSpent: -1 };
    const limit = limitOf(a.limit);
    const [rows, matched] = await Promise.all([
      Customer.find(filter).sort(sort).limit(limit).select('name email phone company totalSpent totalOrders lastOrderAt').lean(),
      Customer.countDocuments(filter),
    ]);
    const cur = ctx.company?.defaultCurrency || 'NGN';
    return {
      matched,
      customers: rows.map((c) => ({
        id: String(c._id), name: c.name, email: c.email || undefined, phone: c.phone || undefined, company: c.company || undefined,
        totalSpent: moneyOf(c.totalSpent || 0, cur), purchases: c.totalOrders || 0, lastPurchase: isoDay(c.lastOrderAt) || 'never',
      })),
    };
  },
};

const find_orders = {
  kind: 'read',
  label: 'Looked through orders',
  description: 'Find store and manual orders by status, payment status, customer or order number, optionally only the last N days.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'open'] },
      paymentStatus: { type: 'string', enum: ['unpaid', 'partial', 'paid', 'refunded'] },
      search: { type: 'string', description: 'Order number or part of the customer name/phone' },
      lastDays: { type: 'integer' },
      limit: { type: 'integer' },
    },
  },
  async run(a, ctx) {
    const filter = { companyId: ctx.companyId };
    if (a.status === 'open') filter.status = { $in: ['pending', 'confirmed', 'processing'] };
    else if (a.status) filter.status = a.status;
    if (a.paymentStatus) filter.paymentStatus = a.paymentStatus;
    if (a.search) filter.$or = [{ orderNumber: rx(a.search) }, { 'customer.name': rx(a.search) }, { 'customer.phone': rx(a.search) }];
    if (a.lastDays > 0) filter.createdAt = { $gte: new Date(Date.now() - a.lastDays * DAY_MS) };
    const limit = limitOf(a.limit);
    const [rows, matched] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).limit(limit).select('orderNumber customer.name total currency status paymentStatus paymentMethod items createdAt').lean(),
      Order.countDocuments(filter),
    ]);
    return {
      matched,
      orders: rows.map((o) => ({
        id: String(o._id), number: o.orderNumber, customer: o.customer?.name,
        total: moneyOf(o.total || 0, o.currency), status: o.status, payment: o.paymentStatus,
        items: (o.items || []).length, placed: isoDay(o.createdAt),
      })),
    };
  },
};

const find_products = {
  kind: 'read',
  label: 'Checked products and stock',
  description: 'Find products, or only those low on / out of stock.',
  parameters: {
    type: 'object',
    properties: {
      lowStock: { type: 'boolean', description: 'At or below their low-stock level' },
      search: { type: 'string' },
      limit: { type: 'integer' },
    },
  },
  async run(a, ctx) {
    const filter = { companyId: ctx.companyId, status: { $ne: 'inactive' } };
    if (a.lowStock) {
      filter['stock.trackStock'] = { $ne: false };
      filter.$expr = { $lte: ['$stock.quantity', { $ifNull: ['$stock.lowStockThreshold', 5] }] };
    }
    if (a.search) filter.$or = [{ name: rx(a.search) }, { sku: rx(a.search) }, { category: rx(a.search) }];
    const limit = limitOf(a.limit);
    const [rows, matched] = await Promise.all([
      Product.find(filter).sort(a.lowStock ? { 'stock.quantity': 1 } : { sold: -1 }).limit(limit).select('name sku category price currency stock status sold').lean(),
      Product.countDocuments(filter),
    ]);
    return {
      matched,
      products: rows.map((p) => ({
        id: String(p._id), name: p.name, sku: p.sku || undefined, price: moneyOf(p.price, p.currency),
        inStock: p.stock?.trackStock === false ? 'not tracked' : p.stock?.quantity ?? 0,
        lowStockLevel: p.stock?.lowStockThreshold ?? 5, status: p.status, sold: p.sold || 0,
      })),
    };
  },
};

const find_appointments = {
  kind: 'read',
  label: 'Checked appointments',
  description: 'Appointments between two dates (default: today to 7 days ahead).',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
      status: { type: 'string', enum: ['pending', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show'] },
      limit: { type: 'integer' },
    },
  },
  async run(a, ctx) {
    const from = parseDay(a.from) ? new Date(`${a.from}T00:00:00+01:00`) : new Date();
    const to = parseDay(a.to, { endOfDay: true }) || new Date(+from + 7 * DAY_MS);
    const filter = { companyId: ctx.companyId, scheduledAt: { $gte: from, $lte: to } };
    if (a.status) filter.status = a.status;
    const rows = await Appointment.find(filter).sort({ scheduledAt: 1 }).limit(limitOf(a.limit, 30))
      .select('title customer.name scheduledAt duration status location isVirtual').lean();
    return {
      from: isoDay(from), to: isoDay(to),
      appointments: rows.map((r) => ({
        title: r.title, customer: r.customer?.name,
        when: new Date(r.scheduledAt).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }),
        minutes: r.duration, status: r.status, where: r.isVirtual ? 'video call' : r.location || undefined,
      })),
    };
  },
};

const expense_summary = {
  kind: 'read',
  label: 'Added up expenses',
  description: 'Expenses over the last N days (default 30): total, by category, and the largest ones.',
  parameters: { type: 'object', properties: { lastDays: { type: 'integer' } } },
  async run(a, ctx) {
    const days = limitOf(a.lastDays, 30, 366);
    const rows = await Expense.find({ companyId: ctx.companyId, date: { $gte: new Date(Date.now() - days * DAY_MS) }, status: { $ne: 'rejected' } })
      .select('title amount currency category date vendor').lean();
    const byCategory = {};
    for (const e of rows) (byCategory[e.category || 'other'] = byCategory[e.category || 'other'] || []).push(e);
    return {
      lastDays: days,
      count: rows.length,
      total: sumByCurrency(rows, (e) => e.amount || 0),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, list]) => [k, sumByCurrency(list, (e) => e.amount || 0)])),
      largest: [...rows].sort((x, y) => y.amount - x.amount).slice(0, 5)
        .map((e) => ({ title: e.title, amount: moneyOf(e.amount, e.currency), on: isoDay(e.date), vendor: e.vendor || undefined })),
    };
  },
};

// ─── Actions (need the person's approval) ───────────────────────────────────

const send_invoice_reminders = {
  kind: 'action',
  label: 'Prepared payment reminders',
  description: `ACTION (needs approval). Email (and SMS where on) a branded payment reminder with the balance, a pay link and bank details to customers with overdue invoices. Pass up to ${MAX_BATCH} invoice numbers from find_invoices. Ineligible ones (paid, not yet overdue, reminded in the last day, no contact) are skipped and reported back.`,
  parameters: {
    type: 'object',
    properties: { invoices: { type: 'array', items: { type: 'string' }, description: 'Invoice numbers, e.g. INV-2026-0011' } },
    required: ['invoices'],
  },
  async prepare(a, ctx) {
    const refs = [...new Set((Array.isArray(a.invoices) ? a.invoices : [a.invoices]).map((r) => plain(r).slice(0, 60).toUpperCase()).filter(Boolean))];
    if (!refs.length) fail('Pass the invoices to remind.');
    if (refs.length > MAX_BATCH) fail(`At most ${MAX_BATCH} invoices at a time.`);
    const now = Date.now();
    const ready = [];
    const skipped = [];
    for (const ref of refs) {
      // eslint-disable-next-line no-await-in-loop
      const inv = await findInvoiceRef(ref, ctx).catch(() => null);
      if (!inv) { skipped.push(`${ref}: not found`); continue; }
      const why = reminderBlocker(inv, ctx.company, now);
      if (why) skipped.push(`${inv.invoiceNumber} (${inv.customer?.name}): ${why}`);
      else ready.push(inv);
    }
    if (!ready.length) fail(`No reminder can go out. ${skipped.join('; ')}`);
    return {
      summary: `Send payment reminders for ${ready.length} overdue invoice${ready.length === 1 ? '' : 's'} (${sumByCurrency(ready, balanceOf)} in total)`,
      details: ready.map((inv) => `${inv.invoiceNumber} · ${inv.customer.name} · ${moneyOf(balanceOf(inv), inv.currency)} due · ${daysSince(inv.dueAt, now)} days overdue · by ${channelsFor(inv, ctx.company)}`),
      args: { invoiceIds: ready.map((inv) => String(inv._id)) },
      note: skipped.length ? `Skipped: ${skipped.join('; ')}` : undefined,
    };
  },
  async execute(args, ctx) {
    const now = new Date();
    const sent = [];
    const skipped = [];
    for (const id of args.invoiceIds || []) {
      // eslint-disable-next-line no-await-in-loop
      const inv = await Invoice.findOne({ _id: id, companyId: ctx.companyId });
      if (!inv) { skipped.push(`${id}: no longer exists`); continue; }
      const why = reminderBlocker(inv, ctx.company, now);
      if (why) { skipped.push(`${inv.invoiceNumber}: ${why}`); continue; }
      // eslint-disable-next-line no-await-in-loop
      const { channels, daysOverdue } = await remind(inv, ctx.company, now);
      if (!channels.length) { skipped.push(`${inv.invoiceNumber}: the message could not be delivered`); continue; }
      if (inv.status !== 'partial') inv.status = 'overdue';
      inv.reminders.push({
        sentAt: now, method: channels[0], auto: false, aiGenerated: true,
        messagePreview: `Reminder sent by the assistant (${daysOverdue}d overdue, by ${channels.join(' and ')})`,
      });
      // eslint-disable-next-line no-await-in-loop
      await inv.save();
      sent.push(inv.invoiceNumber);
    }
    if (!sent.length) fail(`Nothing was sent. ${skipped.join('; ')}`);
    return `Sent ${sent.length} reminder${sent.length === 1 ? '' : 's'} (${sent.join(', ')}).${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}`;
  },
};

const create_invoice = {
  kind: 'action',
  label: 'Prepared an invoice',
  description: 'ACTION (needs approval). Create an invoice, optionally sending it to the customer straight away by email/SMS with a pay link. Never guess prices or quantities: ask if they were not given. Do not ask for the customer\'s email or phone first: leave them out and the saved customer\'s details are filled in; you will be told if none are on file.',
  parameters: {
    type: 'object',
    properties: {
      customerName: { type: 'string' },
      customerEmail: { type: 'string' },
      customerPhone: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { description: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number' } },
          required: ['description', 'quantity', 'unitPrice'],
        },
      },
      dueDate: { type: 'string', description: 'YYYY-MM-DD. Default 7 days from today.' },
      tax: { type: 'number', description: 'Tax amount (not a percentage)' },
      discount: { type: 'number', description: 'Discount amount (not a percentage)' },
      currency: { type: 'string', description: 'ISO code, default the business currency' },
      notes: { type: 'string' },
      send: { type: 'boolean', description: 'Send it to the customer once created' },
    },
    required: ['customerName', 'items'],
  },
  async prepare(a, ctx) {
    const name = str(a.customerName, 120);
    if (!name) fail('Who is the invoice for?');
    let email = str(a.customerEmail, 160).toLowerCase();
    let phone = str(a.customerPhone, 30);
    let address;
    if (email && !EMAIL_RX.test(email)) fail(`"${email}" is not a valid email address.`);
    const saved = await Customer.findOne({
      companyId: ctx.companyId,
      $or: [...(email ? [{ email }] : []), { name: new RegExp(`^${escRx(name)}$`, 'i') }],
    }).select('name email phone address').lean();
    if (saved) { email = email || saved.email || ''; phone = phone || saved.phone || ''; address = saved.address || undefined; }

    const items = (Array.isArray(a.items) ? a.items : []).slice(0, 30).map((i) => {
      const quantity = Number(i.quantity ?? 1);
      const unitPrice = Number(i.unitPrice);
      const description = str(i.description, 300);
      if (!description) fail('Every item needs a description.');
      if (!(quantity > 0)) fail(`Quantity for "${description}" must be more than 0.`);
      if (!(unitPrice >= 0) || !Number.isFinite(unitPrice)) fail(`Give a price for "${description}".`);
      return { description, quantity, unitPrice, total: Math.round(quantity * unitPrice * 100) / 100 };
    });
    if (!items.length) fail('Add at least one item with a price.');
    const subtotal = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
    const tax = Math.max(0, Number(a.tax) || 0);
    const discount = Math.max(0, Number(a.discount) || 0);
    const total = Math.round((subtotal + tax - discount) * 100) / 100;
    if (!(total > 0)) fail('The invoice total must be more than 0.');
    const currency = (str(a.currency, 3) || ctx.company?.defaultCurrency || 'NGN').toUpperCase();
    let dueAt = new Date(Date.now() + 7 * DAY_MS);
    if (a.dueDate) {
      dueAt = parseDay(a.dueDate, { endOfDay: true });
      if (!dueAt) fail('Give the due date as YYYY-MM-DD.');
      if (dueAt < new Date()) fail('The due date is in the past.');
    }
    const send = Boolean(a.send);
    if (send && !email && !(phone && smsOn(ctx.company))) fail(`To send it I need ${name}'s email address${smsOn(ctx.company) ? ' or phone number' : ''}.`);

    return {
      summary: `Create invoice for ${name}: ${moneyOf(total, currency)}, due ${niceDay(dueAt)}${send ? `, and send it by ${channelsFor({ customer: { email, phone } }, ctx.company)}` : ' (saved as a draft)'}`,
      details: [
        ...items.map((i) => `${i.quantity} × ${i.description} @ ${moneyOf(i.unitPrice, currency)} = ${moneyOf(i.total, currency)}`),
        ...(tax ? [`Tax: ${moneyOf(tax, currency)}`] : []),
        ...(discount ? [`Discount: −${moneyOf(discount, currency)}`] : []),
        `Customer: ${[name, email, phone].filter(Boolean).join(' · ')}`,
      ],
      args: {
        invoice: {
          customer: { name, ...(email && { email }), ...(phone && { phone }), ...(address && { address }) },
          items, subtotal, tax, discount, total, currency, dueAt: dueAt.toISOString(),
          ...(a.notes && { notes: str(a.notes, 1000) }), status: 'draft',
        },
        send,
      },
    };
  },
  async execute(args, ctx) {
    const { createInvoiceRecord, dispatchInvoiceToCustomer } = require('../../controllers/invoiceController');
    const invoice = await createInvoiceRecord(args.invoice, ctx.companyId, ctx.userId);
    const amount = moneyOf(invoice.total, invoice.currency);
    if (!args.send) return `Created ${invoice.invoiceNumber} for ${invoice.customer.name} (${amount}) as a draft. It has not been sent.`;
    await dispatchInvoiceToCustomer(invoice, ctx.company);
    const url = canPayOnline(ctx.company, invoice) ? await payLink(invoice) : null;
    return `Created ${invoice.invoiceNumber} for ${invoice.customer.name} (${amount}) and sent it.${url ? ` Pay link: ${url}` : ''}`;
  },
};

const record_invoice_payment = {
  kind: 'action',
  label: 'Prepared a payment record',
  description: 'ACTION (needs approval). Record money received outside online payment (bank transfer, cash, POS) against an invoice. Always pass the amount the user said was received.',
  parameters: {
    type: 'object',
    properties: {
      invoice: { type: 'string', description: 'Invoice number' },
      amount: { type: 'number', description: 'Amount received, as a plain number, e.g. 10000' },
      method: { type: 'string', enum: ['bank_transfer', 'cash', 'pos', 'other'] },
      paidOn: { type: 'string', description: 'YYYY-MM-DD, default today' },
      note: { type: 'string' },
    },
    required: ['invoice', 'amount'],
  },
  async prepare(a, ctx) {
    const inv = await findInvoiceRef(a.invoice, ctx);
    if (inv.status === 'cancelled') fail(`${inv.invoiceNumber} is cancelled.`);
    const balance = balanceOf(inv);
    if (balance <= 0) fail(`${inv.invoiceNumber} is already fully paid.`);
    // Never default to the balance: the card must match what the user said.
    const amount = Math.round(Number(String(a.amount ?? '').replace(/[^\d.]/g, '')) * 100) / 100;
    if (!(amount > 0)) fail(`Pass the amount received. ${moneyOf(balance, inv.currency)} is left on ${inv.invoiceNumber}.`);
    if (amount > balance) fail(`Only ${moneyOf(balance, inv.currency)} is left to pay on ${inv.invoiceNumber}.`);
    let paidAt;
    if (a.paidOn) {
      const d = parseDay(a.paidOn);
      if (!d) fail('Give the payment date as YYYY-MM-DD.');
      paidAt = new Date(Math.min(+d, Date.now()));
      if (d - Date.now() > DAY_MS) fail('The payment date is in the future.');
    }
    const method = ['bank_transfer', 'cash', 'pos', 'other'].includes(a.method) ? a.method : 'bank_transfer';
    const left = Math.round((balance - amount) * 100) / 100;
    return {
      summary: `Record a ${moneyOf(amount, inv.currency)} ${method.replace('_', ' ')} payment on ${inv.invoiceNumber} (${inv.customer?.name})`,
      details: [
        left > 0 ? `${moneyOf(left, inv.currency)} will still be owed.` : 'This pays the invoice in full.',
        ...(paidAt ? [`Received on ${niceDay(paidAt)}`] : []),
        ...(a.note ? [`Note: ${str(a.note, 300)}`] : []),
      ],
      args: { invoiceId: String(inv._id), amount, method, ...(paidAt && { paidAt: paidAt.toISOString() }), ...(a.note && { note: str(a.note, 300) }) },
    };
  },
  async execute(args, ctx) {
    const { recordManualPayment } = require('../../controllers/invoiceController');
    const inv = await recordManualPayment(args.invoiceId, ctx.companyId, ctx.userId, args);
    const left = balanceOf(inv);
    return `Recorded on ${inv.invoiceNumber}. ${left > 0 ? `${moneyOf(left, inv.currency)} still owed.` : 'It is now fully paid.'}`;
  },
};

const update_lead = {
  kind: 'action',
  label: 'Prepared a lead update',
  description: 'ACTION (needs approval). Change a lead\'s status, set its next follow-up date, and/or add a note.',
  parameters: {
    type: 'object',
    properties: {
      lead: { type: 'string', description: 'Lead id from find_leads (or exact name)' },
      status: { type: 'string', enum: LEAD_STATUSES },
      nextFollowUp: { type: 'string', description: 'YYYY-MM-DD' },
      note: { type: 'string' },
    },
    required: ['lead'],
  },
  async prepare(a, ctx) {
    const lead = await findLeadRef(a.lead, ctx);
    const changes = [];
    const args = { leadId: String(lead._id) };
    if (a.status && a.status !== lead.status) {
      if (!LEAD_STATUSES.includes(a.status)) fail('Unknown lead status.');
      args.status = a.status; changes.push(`Status: ${lead.status} → ${a.status}`);
    }
    if (a.nextFollowUp) {
      const d = parseDay(a.nextFollowUp);
      if (!d) fail('Give the follow-up date as YYYY-MM-DD.');
      args.nextFollowUpAt = d.toISOString(); changes.push(`Next follow-up: ${niceDay(d)}`);
    }
    if (str(a.note)) { args.note = str(a.note, 2000); changes.push(`Note: ${args.note}`); }
    if (!changes.length) fail('Nothing to change on this lead.');
    return { summary: `Update lead ${lead.name}${lead.company ? ` (${lead.company})` : ''}`, details: changes, args };
  },
  async execute(args, ctx) {
    const lead = await Lead.findOne({ _id: args.leadId, companyId: ctx.companyId });
    if (!lead) fail('That lead no longer exists.');
    if (args.status && args.status !== lead.status) {
      lead.activities.push({ type: 'status_change', description: `Status changed from ${lead.status} to ${args.status}`, performedBy: ctx.userId });
      lead.status = args.status;
    }
    if (args.nextFollowUpAt) { lead.nextFollowUpAt = new Date(args.nextFollowUpAt); lead.followUpRemindedAt = undefined; }
    if (args.note) lead.notes.push({ content: args.note, createdBy: ctx.userId });
    await lead.save();
    return `Updated ${lead.name}.`;
  },
};

const send_email = {
  kind: 'action',
  label: 'Drafted an email',
  description: 'ACTION (needs approval). Email one lead or customer from the business, for follow-ups, thank-yous or offers. Write the full message yourself, signed as the business. The person sees the exact text before it goes. One call per recipient.',
  parameters: {
    type: 'object',
    properties: {
      recipientType: { type: 'string', enum: ['lead', 'customer'] },
      recipientId: { type: 'string', description: 'Id from find_leads or find_customers' },
      subject: { type: 'string' },
      message: { type: 'string', description: 'Plain text body, with a greeting and sign-off' },
    },
    required: ['recipientType', 'recipientId', 'subject', 'message'],
  },
  async prepare(a, ctx) {
    const Model = a.recipientType === 'customer' ? Customer : Lead;
    if (!mongoose.isValidObjectId(a.recipientId)) fail(`Look the ${a.recipientType || 'lead'} up first and use its id.`);
    const who = await Model.findOne({ _id: a.recipientId, companyId: ctx.companyId }).select('name email').lean();
    if (!who) fail(`No ${a.recipientType} with that id.`);
    if (!who.email || !EMAIL_RX.test(who.email)) fail(`${who.name} has no email address on file.`);
    const subject = str(a.subject, 150);
    const message = String(a.message || '').trim().slice(0, 5000);
    if (!subject || !message) fail('The email needs a subject and a message.');
    return {
      summary: `Email ${who.name} (${who.email}): "${subject}"`,
      details: [message],
      args: { recipientType: a.recipientType === 'customer' ? 'customer' : 'lead', recipientId: String(who._id), subject, message },
    };
  },
  async execute(args, ctx) {
    const Model = args.recipientType === 'customer' ? Customer : Lead;
    const who = await Model.findOne({ _id: args.recipientId, companyId: ctx.companyId });
    if (!who?.email) fail('That contact no longer has an email address.');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const body = args.message.split(/\n{2,}/).map((p) => `<p style="color:#334155;line-height:1.7;margin:0 0 14px;">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');
    const c = ctx.company;
    const sent = await emailService.sendEmail({
      to: who.email,
      subject: args.subject,
      html: emailService.baseTemplate(args.subject, body, { name: c?.companyName, logo: c?.logo, tagline: c?.profile?.tagline }),
      text: args.message,
      ...(c?.profile?.email && { replyTo: c.profile.email }),
    });
    if (!sent) fail('The email service did not accept the message. Nothing was sent.');
    if (args.recipientType === 'lead') {
      who.activities.push({ type: 'email', description: `Email sent: ${args.subject}`, performedBy: ctx.userId });
      who.lastContactedAt = new Date();
      if (who.status === 'new') who.status = 'contacted';
      await who.save();
    }
    return `Email sent to ${who.name}.`;
  },
};

const set_invoice_auto_reminders = {
  kind: 'action',
  label: 'Prepared a reminder setting',
  description: 'ACTION (needs approval). Pause or resume the automatic overdue reminders for one invoice.',
  parameters: {
    type: 'object',
    properties: { invoice: { type: 'string' }, paused: { type: 'boolean' } },
    required: ['invoice', 'paused'],
  },
  async prepare(a, ctx) {
    const inv = await findInvoiceRef(a.invoice, ctx, 'invoiceNumber customer remindersPaused');
    const paused = Boolean(a.paused);
    if (Boolean(inv.remindersPaused) === paused) fail(`Automatic reminders for ${inv.invoiceNumber} are already ${paused ? 'paused' : 'on'}.`);
    return {
      summary: `${paused ? 'Pause' : 'Resume'} automatic reminders for ${inv.invoiceNumber} (${inv.customer?.name})`,
      details: [],
      args: { invoiceId: String(inv._id), paused },
    };
  },
  async execute(args, ctx) {
    const inv = await Invoice.findOneAndUpdate({ _id: args.invoiceId, companyId: ctx.companyId }, { $set: { remindersPaused: args.paused } }, { new: true });
    if (!inv) fail('That invoice no longer exists.');
    return `Automatic reminders for ${inv.invoiceNumber} are now ${args.paused ? 'paused' : 'on'}.`;
  },
};

const TOOLS = {
  business_snapshot, find_invoices, get_invoice, find_leads, find_customers, find_orders, find_products, find_appointments, expense_summary,
  send_invoice_reminders, create_invoice, record_invoice_payment, update_lead, send_email, set_invoice_auto_reminders,
};

const schemas = () => Object.entries(TOOLS).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: t.parameters },
}));

module.exports = { TOOLS, schemas, MAX_BATCH };
