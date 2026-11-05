'use strict';

// Laundry & dry cleaning: price list, tickets at the counter, the
// received → washing → ready → collected board, payments and the
// "your clothes are ready" message.

const mongoose = require('mongoose');
const LaundryOrder = require('../models/LaundryOrder');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { settingsFor } = require('../utils/serviceDefaults');
const { recordCustomerTransaction } = require('../utils/customerSync');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const {
  round2, isManager, lagosDay, lagosAt, nextNumber, cleanCustomer, cleanPayment, addPayment, emailCustomer, DAY_MS,
} = require('../utils/serviceJobs');

const ACTIVE = ['received', 'washing', 'ready'];
const NEXT = { received: ['washing', 'ready'], washing: ['ready', 'received'], ready: ['collected', 'washing'] };
const STATUS_LABEL = { received: 'Received', washing: 'Washing', ready: 'Ready for pickup', collected: 'Collected', cancelled: 'Cancelled' };
const UNITS = ['piece', 'kg', 'pair', 'set'];
const MAX_ITEMS = 200;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function settingsView(s) {
  const l = s.laundry;
  return {
    services: l.services,
    items: l.items.map((i) => ({ id: String(i._id), name: i.name, category: i.category || '', unit: i.unit, prices: Object.fromEntries(i.prices || []), active: i.active !== false })),
    expressPercent: l.expressPercent, turnaroundDays: l.turnaroundDays, expressDays: l.expressDays,
    pickupFee: l.pickupFee, deliveryFee: l.deliveryFee, uncollectedDays: l.uncollectedDays,
  };
}

function orderView(o) {
  const balance = Math.max(0, round2(o.total - o.amountPaid));
  return {
    id: String(o._id), ticketNumber: o.ticketNumber, customer: o.customer, items: o.items.map((i) => ({
      item: i.item, service: i.service, unit: i.unit, quantity: i.quantity, price: i.price, lineTotal: round2(i.price * i.quantity),
      description: i.description || '', condition: i.condition || '',
    })),
    pieces: o.pieces, express: o.express, pickup: o.pickup, delivery: o.delivery,
    subtotal: o.subtotal, expressCharge: o.expressCharge, pickupFee: o.pickupFee, deliveryFee: o.deliveryFee, discount: o.discount,
    total: o.total, amountPaid: o.amountPaid, balance, currency: o.currency,
    paymentStatus: o.amountPaid <= 0 ? 'unpaid' : balance > 0 ? 'part_paid' : 'paid',
    payments: (o.payments || []).map((p) => ({ amount: p.amount, method: p.method, at: p.at, byName: p.byName, note: p.note || '' })),
    status: o.status, statusLabel: STATUS_LABEL[o.status], dueAt: o.dueAt, readyAt: o.readyAt, collectedAt: o.collectedAt,
    readyNotifiedAt: o.readyNotifiedAt, overdue: ACTIVE.slice(0, 2).includes(o.status) && o.dueAt && new Date(o.dueAt) < new Date(),
    timeline: o.timeline, notes: o.notes || '', createdAt: o.createdAt, createdByName: o.createdByName || '',
  };
}

async function findOrder(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Ticket not found.', 404);
  const o = await LaundryOrder.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!o) throw new AppError('Ticket not found.', 404);
  return o;
}

const companyOf = (id) => Company.findById(id).select('companyName logo profile defaultCurrency').lean();

// ── Settings ─────────────────────────────────────────────────────────────
exports.getSettings = async (req, res, next) => {
  try {
    const [s, company] = await Promise.all([settingsFor(req.companyId), companyOf(req.companyId)]);
    res.json({ success: true, data: { ...settingsView(s), currency: company?.defaultCurrency || 'NGN' } });
  } catch (err) { next(err); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = await settingsFor(req.companyId);
    if (b.services !== undefined) {
      const services = [...new Set((Array.isArray(b.services) ? b.services : []).map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean))];
      if (!services.length) return next(new AppError('Keep at least one service, e.g. Wash & Iron.', 400));
      if (services.length > 15) return next(new AppError('Up to 15 services.', 400));
      s.set('laundry.services', services);
    }
    const services = s.laundry.services;
    if (b.items !== undefined) {
      if (!Array.isArray(b.items) || b.items.length > 400) return next(new AppError('Up to 400 items on the price list.', 400));
      const seen = new Set();
      const items = [];
      for (const raw of b.items) {
        const name = String(raw?.name || '').trim().slice(0, 80);
        if (!name) continue;
        if (seen.has(name.toLowerCase())) return next(new AppError(`"${name}" is on the price list twice.`, 400));
        seen.add(name.toLowerCase());
        const prices = {};
        for (const svc of services) {
          const v = raw.prices?.[svc];
          if (v === undefined || v === null || v === '') continue;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return next(new AppError(`Check the ${svc} price for ${name}.`, 400));
          prices[svc] = round2(n);
        }
        items.push({ name, category: String(raw.category || '').trim().slice(0, 40), unit: UNITS.includes(raw.unit) ? raw.unit : 'piece', prices, active: raw.active !== false });
      }
      s.set('laundry.items', items);
    }
    for (const [k, max] of [['expressPercent', 300], ['turnaroundDays', 60], ['expressDays', 30], ['pickupFee', 1e7], ['deliveryFee', 1e7], ['uncollectedDays', 365]]) {
      if (b[k] === undefined) continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0 || n > max) return next(new AppError(`Check the value for ${k}.`, 400));
      s.set(`laundry.${k}`, k === 'uncollectedDays' ? Math.max(1, Math.round(n)) : round2(n));
    }
    await s.save();
    res.json({ success: true, data: settingsView(s) });
  } catch (err) { next(err); }
};

// ── Tickets ──────────────────────────────────────────────────────────────
exports.listOrders = async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const s = await settingsFor(req.companyId);
    const filter = { companyId: req.companyId };
    if (status === 'active' || !status) filter.status = { $in: ACTIVE };
    else if (status === 'overdue') { filter.status = { $in: ['received', 'washing'] }; filter.dueAt = { $lt: new Date() }; }
    else if (status === 'uncollected') { filter.status = 'ready'; filter.readyAt = { $lt: new Date(Date.now() - s.laundry.uncollectedDays * DAY_MS) }; }
    else if (status === 'owing') { filter.status = { $ne: 'cancelled' }; filter.$expr = { $gt: ['$total', { $add: ['$amountPaid', 0.009] }] }; }
    else if (status !== 'all') filter.status = status;
    if (search) {
      const q = esc(String(search).trim().slice(0, 60));
      filter.$or = [{ ticketNumber: { $regex: q, $options: 'i' } }, { 'customer.name': { $regex: q, $options: 'i' } }, { 'customer.phone': { $regex: q } }];
    }
    const today = lagosDay();
    const now = new Date();
    const [orders, counts] = await Promise.all([
      LaundryOrder.find(filter).sort(filter.status === 'collected' ? { collectedAt: -1 } : { dueAt: 1, createdAt: 1 }).limit(500),
      LaundryOrder.aggregate([
        { $match: { companyId: new mongoose.Types.ObjectId(String(req.companyId)), status: { $ne: 'cancelled' } } },
        { $group: {
          _id: null,
          received: { $sum: { $cond: [{ $eq: ['$status', 'received'] }, 1, 0] } },
          washing: { $sum: { $cond: [{ $eq: ['$status', 'washing'] }, 1, 0] } },
          ready: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['received', 'washing']] }, { $lt: ['$dueAt', now] }] }, 1, 0] } },
          dueToday: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['received', 'washing']] }, { $gte: ['$dueAt', today.start] }, { $lt: ['$dueAt', today.end] }] }, 1, 0] } },
          uncollected: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'ready'] }, { $lt: ['$readyAt', new Date(Date.now() - s.laundry.uncollectedDays * DAY_MS)] }] }, 1, 0] } },
          receivedToday: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', today.start] }, { $lt: ['$createdAt', today.end] }] }, 1, 0] } },
          collectedToday: { $sum: { $cond: [{ $and: [{ $gte: ['$collectedAt', today.start] }, { $lt: ['$collectedAt', today.end] }] }, 1, 0] } },
          owed: { $sum: { $max: [0, { $subtract: ['$total', '$amountPaid'] }] } },
          owing: { $sum: { $cond: [{ $gt: ['$total', { $add: ['$amountPaid', 0.009] }] }, 1, 0] } },
        } },
      ]),
    ]);
    const paidToday = await LaundryOrder.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(String(req.companyId)), 'payments.at': { $gte: today.start, $lt: today.end } } },
      { $unwind: '$payments' },
      { $match: { 'payments.at': { $gte: today.start, $lt: today.end } } },
      { $group: { _id: null, total: { $sum: '$payments.amount' } } },
    ]);
    const c = counts[0] || {};
    res.json({
      success: true,
      data: {
        orders: orders.map(orderView),
        counts: {
          received: c.received || 0, washing: c.washing || 0, ready: c.ready || 0, overdue: c.overdue || 0, dueToday: c.dueToday || 0,
          uncollected: c.uncollected || 0, receivedToday: c.receivedToday || 0, collectedToday: c.collectedToday || 0,
          owing: c.owing || 0, owed: round2(c.owed || 0), paidToday: round2(paidToday[0]?.total || 0),
        },
        uncollectedDays: s.laundry.uncollectedDays,
      },
    });
  } catch (err) { next(err); }
};

exports.createOrder = async (req, res, next) => {
  try {
    const b = req.body || {};
    const customer = { ...cleanCustomer(b.customer, { requirePhone: true }), address: String(b.customer?.address || '').trim().slice(0, 300) };
    const s = await settingsFor(req.companyId);
    const cfg = s.laundry;
    const priceList = new Map(cfg.items.filter((i) => i.active !== false).map((i) => [i.name.toLowerCase(), i]));
    const lines = Array.isArray(b.items) ? b.items : [];
    if (!lines.length) return next(new AppError('Add at least one item.', 400));
    if (lines.length > MAX_ITEMS) return next(new AppError(`Up to ${MAX_ITEMS} lines on one ticket.`, 400));

    const items = [];
    for (const l of lines) {
      const entry = priceList.get(String(l.item || '').trim().toLowerCase());
      if (!entry) return next(new AppError(`"${l.item}" is not on your price list.`, 400));
      const service = String(l.service || '');
      const price = entry.prices?.get(service);
      if (price === undefined) return next(new AppError(`${entry.name} has no price for ${service || 'that service'}. Set it on the price list.`, 400));
      const quantity = round2(l.quantity);
      if (!(quantity > 0) || quantity > 1000) return next(new AppError(`Check the quantity for ${entry.name}.`, 400));
      if (entry.unit !== 'kg' && !Number.isInteger(quantity)) return next(new AppError(`${entry.name} is counted in whole ${entry.unit}s.`, 400));
      items.push({
        item: entry.name, service, unit: entry.unit, quantity, price,
        description: String(l.description || '').trim().slice(0, 200) || undefined,
        condition: String(l.condition || '').trim().slice(0, 200) || undefined,
      });
    }

    const subtotal = round2(items.reduce((t, i) => t + i.price * i.quantity, 0));
    const express = Boolean(b.express);
    const expressCharge = express ? round2(subtotal * (cfg.expressPercent || 0) / 100) : 0;
    const pickupFee = b.pickup ? round2(cfg.pickupFee) : 0;
    const deliveryFee = b.delivery ? round2(cfg.deliveryFee) : 0;
    const gross = round2(subtotal + expressCharge + pickupFee + deliveryFee);
    const discount = round2(Math.max(0, Number(b.discount) || 0));
    if (discount > gross) return next(new AppError('The discount is more than the bill.', 400));
    if (discount > 0 && !isManager(req.user) && discount > gross * 0.2) return next(new AppError('Discounts above 20% need a manager.', 403));
    if ((b.pickup || b.delivery) && !customer.address) return next(new AppError('Add the customer\'s address for pickup or delivery.', 400));

    let dueAt = b.dueAt ? new Date(b.dueAt) : lagosAt(express ? cfg.expressDays : cfg.turnaroundDays);
    if (Number.isNaN(dueAt.getTime()) || dueAt < new Date(Date.now() - DAY_MS)) dueAt = lagosAt(express ? cfg.expressDays : cfg.turnaroundDays);

    const company = await companyOf(req.companyId);
    const pieces = items.reduce((t, i) => t + (i.unit === 'kg' ? 0 : i.quantity * (i.unit === 'pair' ? 2 : 1)), 0);
    const total = round2(gross - discount);
    let payment = null;
    if (b.payment && Number(b.payment.amount) > 0) {
      payment = cleanPayment(b.payment);
      if (payment.amount > total + 0.009) return next(new AppError('The payment is more than the bill.', 400));
    }

    const order = await LaundryOrder.create({
      companyId: req.companyId,
      ticketNumber: await nextNumber(req.companyId, 'laundry', 'LD-', 5),
      customer, items, pieces, express, pickup: Boolean(b.pickup), delivery: Boolean(b.delivery),
      subtotal, expressCharge, pickupFee, deliveryFee, discount, total,
      amountPaid: payment ? payment.amount : 0,
      payments: payment ? [{ ...payment, at: new Date(), by: req.user._id, byName: req.user.name || '' }] : [],
      currency: company?.defaultCurrency || 'NGN',
      dueAt, status: 'received',
      timeline: [{ status: 'received', note: `${pieces || items.length} item(s) received`, byName: req.user.name || '' }],
      notes: String(b.notes || '').trim().slice(0, 1000) || undefined,
      createdBy: req.user._id, createdByName: req.user.name || '',
    });

    recordCustomerTransaction({ companyId: req.companyId, customer, amount: total, countsAsOrder: true, userId: req.user._id }).catch(() => {});
    cache.del(`dashboard_${req.companyId}`);
    res.status(201).json({ success: true, data: { ...orderView(order), business: businessOf(company) } });
  } catch (err) { next(err); }
};

const businessOf = (c) => (c ? { name: c.companyName, logo: c.logo || '', phone: c.profile?.phone || '', address: c.profile?.address || '' } : null);

exports.getOrder = async (req, res, next) => {
  try {
    const [o, company] = await Promise.all([findOrder(req), companyOf(req.companyId)]);
    res.json({ success: true, data: { ...orderView(o), business: businessOf(company) } });
  } catch (err) { next(err); }
};

exports.updateOrder = async (req, res, next) => {
  try {
    const o = await findOrder(req);
    if (['collected', 'cancelled'].includes(o.status)) return next(new AppError(`This ticket is ${o.status}.`, 400));
    const b = req.body || {};
    if (b.notes !== undefined) o.notes = String(b.notes || '').trim().slice(0, 1000);
    if (b.dueAt !== undefined) {
      const d = new Date(b.dueAt);
      if (Number.isNaN(d.getTime())) return next(new AppError('Check the due date.', 400));
      o.dueAt = d;
      o.timeline.push({ status: 'note', note: `Due date changed to ${d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' })}`, byName: req.user.name || '' });
    }
    if (b.customer) {
      if (b.customer.phone !== undefined) o.customer.phone = String(b.customer.phone || '').trim().slice(0, 30);
      if (b.customer.email !== undefined) {
        const e = String(b.customer.email || '').trim().toLowerCase();
        if (e && !/^\S+@\S+\.\S+$/.test(e)) return next(new AppError('The email does not look right.', 400));
        o.customer.email = e;
      }
      if (b.customer.address !== undefined) o.customer.address = String(b.customer.address || '').trim().slice(0, 300);
    }
    await o.save();
    res.json({ success: true, data: orderView(o) });
  } catch (err) { next(err); }
};

exports.setStatus = async (req, res, next) => {
  try {
    const o = await findOrder(req);
    const to = req.body?.status;
    if (!(NEXT[o.status] || []).includes(to)) return next(new AppError(`A ${STATUS_LABEL[o.status].toLowerCase()} ticket can't be moved to ${STATUS_LABEL[to] || to}.`, 400));
    const balance = round2(o.total - o.amountPaid);
    if (to === 'collected' && balance > 0 && !req.body?.allowBalance) {
      return next(new AppError(`The customer still owes ${balance.toLocaleString('en-NG')}. Record their payment first.`, 409));
    }
    // Claim the change so two people pressing at once can't both apply it.
    const update = { status: to };
    if (to === 'ready') update.readyAt = new Date();
    if (to === 'collected') update.collectedAt = new Date();
    const note = to === 'collected' && balance > 0 ? `Collected owing ${balance.toLocaleString('en-NG')}` : undefined;
    const saved = await LaundryOrder.findOneAndUpdate(
      { _id: o._id, companyId: req.companyId, status: o.status },
      { $set: update, $push: { timeline: { status: to, note, at: new Date(), byName: req.user.name || '' } } },
      { new: true },
    );
    if (!saved) return next(new AppError('Someone else just updated this ticket. Refresh and try again.', 409));

    let emailed = false;
    if (to === 'ready' && saved.customer.email && !saved.readyNotifiedAt) {
      emailed = await sendReadyEmail(saved, await companyOf(req.companyId));
    }
    res.json({ success: true, emailed, data: orderView(saved) });
  } catch (err) { next(err); }
};

async function sendReadyEmail(o, company) {
  const bal = round2(o.total - o.amountPaid);
  const money = (n) => `${o.currency === 'NGN' ? '₦' : `${o.currency} `}${Number(n).toLocaleString('en-NG')}`;
  const ok = await emailCustomer({
    company, to: o.customer.email,
    subject: `Your laundry is ready: ticket ${o.ticketNumber}`,
    lines: [
      `Hi ${o.customer.name},`,
      `Your clothes (ticket ${o.ticketNumber}, ${o.pieces || o.items.length} item${(o.pieces || o.items.length) === 1 ? '' : 's'}) are ready for ${o.delivery ? 'delivery' : 'pickup'}.`,
      bal > 0 ? `Balance to pay: ${money(bal)}.` : 'Your bill is fully paid.',
      'Please bring your ticket number when you come. Thank you!',
    ],
  });
  if (ok) await LaundryOrder.updateOne({ _id: o._id }, { readyNotifiedAt: new Date() });
  return ok;
}

exports.notifyReady = async (req, res, next) => {
  try {
    const o = await findOrder(req);
    if (o.status !== 'ready') return next(new AppError('Mark the ticket ready first.', 400));
    if (!o.customer.email) return next(new AppError('This customer has no email. Use WhatsApp instead.', 400));
    const ok = await sendReadyEmail(o, await companyOf(req.companyId));
    if (!ok) return next(new AppError('The email could not be sent. Use WhatsApp instead.', 502));
    res.json({ success: true, message: 'Email sent.' });
  } catch (err) { next(err); }
};

exports.addPayment = async (req, res, next) => {
  try {
    const o = await findOrder(req);
    const saved = await addPayment(LaundryOrder, o, 'total', cleanPayment(req.body), req.user);
    cache.del(`dashboard_${req.companyId}`);
    res.json({ success: true, data: orderView(saved) });
  } catch (err) { next(err); }
};

exports.cancelOrder = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) return next(new AppError('Say why the ticket is being cancelled.', 400));
    const o = await findOrder(req);
    if (o.status === 'collected') return next(new AppError('A collected ticket can\'t be cancelled.', 400));
    const saved = await LaundryOrder.findOneAndUpdate(
      { _id: o._id, companyId: req.companyId, status: { $nin: ['collected', 'cancelled'] } },
      { $set: { status: 'cancelled' }, $push: { timeline: { status: 'cancelled', note: reason, at: new Date(), byName: req.user.name || '' } } },
      { new: true },
    );
    if (!saved) return next(new AppError('This ticket was already closed.', 409));
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id, action: 'laundry_ticket_cancelled', resource: 'LaundryOrder', resourceId: o._id,
      description: `Cancelled laundry ticket ${o.ticketNumber}: ${reason}`, ip: req.ip,
    });
    res.json({ success: true, data: orderView(saved) });
  } catch (err) { next(err); }
};

// Recent tickets for a phone number, to fill in a returning customer.
exports.findCustomer = async (req, res, next) => {
  try {
    const phone = String(req.query.phone || '').replace(/[^\d+]/g, '');
    if (phone.length < 4) return res.json({ success: true, data: [] });
    const rows = await LaundryOrder.find({ companyId: req.companyId, 'customer.phone': { $regex: esc(phone) } })
      .sort({ createdAt: -1 }).limit(20).select('customer').lean();
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.customer.phone)) seen.set(r.customer.phone, r.customer);
    res.json({ success: true, data: [...seen.values()].slice(0, 5) });
  } catch (err) { next(err); }
};

exports._orderView = orderView;
exports.NEXT = NEXT;
