'use strict';

const mongoose = require('mongoose');
const Matter = require('../models/Matter');
const MatterEntry = require('../models/MatterEntry');
const TrustTransaction = require('../models/TrustTransaction');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Lead = require('../models/Lead');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const { createWithNumber } = require('../utils/invoiceNumbers');
const { currencyFieldsFor } = require('../services/currencyService');

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAY_MS = 24 * 60 * 60 * 1000;

const MATTER_EDITABLE_FIELDS = [
  'title', 'description', 'practiceArea', 'status', 'client', 'court',
  'opposingParties', 'relatedParties', 'responsibleLawyer', 'team', 'billing', 'tags',
];
const KEY_DATE_FIELDS = ['title', 'type', 'date', 'location', 'notes', 'done'];

async function findMatter(req, id = req.params.id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Matter not found.', 404);
  const matter = await Matter.findOne({ _id: id, companyId: req.companyId });
  if (!matter) throw new AppError('Matter not found.', 404);
  return matter;
}

async function nextMatterNumber(companyId) {
  const prefix = `MAT-${new Date().getFullYear()}-`;
  const rows = await Matter.find({ companyId, matterNumber: { $regex: `^${prefix}\\d+$` } }).select('matterNumber').lean();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.matterNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

// Unbilled / billed totals per matter, in one aggregation.
async function entryTotals(companyId, matterIds) {
  const rows = await MatterEntry.aggregate([
    { $match: { companyId: oid(companyId), matterId: { $in: matterIds.map(oid) }, billable: true } },
    { $group: {
      _id: { matterId: '$matterId', billed: { $ne: ['$invoiceId', null] }, kind: '$kind' },
      amount: { $sum: '$amount' }, minutes: { $sum: { $ifNull: ['$minutes', 0] } },
    } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const k = String(r._id.matterId);
    const t = out.get(k) || { unbilledTime: 0, unbilledExpenses: 0, unbilledMinutes: 0, billed: 0 };
    if (r._id.billed) t.billed += r.amount;
    else if (r._id.kind === 'time') { t.unbilledTime += r.amount; t.unbilledMinutes += r.minutes; }
    else t.unbilledExpenses += r.amount;
    out.set(k, t);
  }
  return out;
}

// ── Conflict of interest check ───────────────────────────────────────────
// Searches every name involved in a (prospective) matter against existing
// matters' clients and opposing/related parties, plus customers and leads.
// The serious case is a name that is our CLIENT on one side and the
// OPPOSING party on the other — flagged as `severity: 'high'`.
async function runConflictCheck(companyId, { clientName, opposingNames = [], relatedNames = [] }, excludeMatterId) {
  const probes = [
    ...(clientName ? [{ name: clientName, as: 'client' }] : []),
    ...opposingNames.map((name) => ({ name, as: 'opposing' })),
    ...relatedNames.map((name) => ({ name, as: 'related' })),
  ].filter((p) => p.name && String(p.name).trim().length >= 2);
  if (!probes.length) return [];

  const hits = [];
  for (const probe of probes) {
    const re = new RegExp(escapeRe(String(probe.name).trim()), 'i');
    // eslint-disable-next-line no-await-in-loop
    const [matters, customers, leads] = await Promise.all([
      Matter.find({
        companyId,
        ...(excludeMatterId && { _id: { $ne: excludeMatterId } }),
        $or: [{ 'client.name': re }, { 'opposingParties.name': re }, { 'relatedParties.name': re }],
      }).select('matterNumber title status client opposingParties relatedParties').limit(20).lean(),
      Customer.find({ companyId, $or: [{ name: re }, { company: re }] }).select('name company email').limit(10).lean(),
      Lead.find({ companyId, $or: [{ name: re }, { company: re }] }).select('name company email').limit(10).lean(),
    ]);

    for (const m of matters) {
      const relations = [];
      if (re.test(m.client?.name || '')) relations.push('client');
      if ((m.opposingParties || []).some((p) => re.test(p.name))) relations.push('opposing');
      if ((m.relatedParties || []).some((p) => re.test(p.name))) relations.push('related');
      for (const rel of relations) {
        const adverse = (probe.as === 'client' && rel === 'opposing') || (probe.as === 'opposing' && rel === 'client');
        hits.push({
          searched: probe.name, searchedAs: probe.as, source: 'matter', foundAs: rel,
          severity: adverse ? 'high' : 'low',
          matterId: m._id, matterNumber: m.matterNumber, title: m.title, status: m.status,
        });
      }
    }
    // An existing customer/lead turning up as the OTHER side is worth a look.
    if (probe.as === 'opposing') {
      customers.forEach((c) => hits.push({ searched: probe.name, searchedAs: probe.as, source: 'customer', foundAs: 'customer', severity: 'medium', name: c.name, company: c.company, email: c.email }));
      leads.forEach((l) => hits.push({ searched: probe.name, searchedAs: probe.as, source: 'lead', foundAs: 'lead', severity: 'low', name: l.name, company: l.company, email: l.email }));
    }
  }
  return hits;
}

// responsibleLawyer/team come from the client — keep only this firm's users.
async function sanitizeTeam(companyId, body) {
  const User = require('../models/User');
  const ids = [body.responsibleLawyer, ...(Array.isArray(body.team) ? body.team : [])]
    .filter((id) => id && mongoose.isValidObjectId(id));
  const valid = new Set((await User.find({ _id: { $in: ids }, companyId }).select('_id').lean()).map((u) => String(u._id)));
  if (body.responsibleLawyer !== undefined) body.responsibleLawyer = valid.has(String(body.responsibleLawyer)) ? body.responsibleLawyer : undefined;
  if (body.team !== undefined) body.team = (Array.isArray(body.team) ? body.team : []).filter((id) => valid.has(String(id)));
  return body;
}

function namesFrom(body) {
  return {
    clientName: body.client?.name,
    opposingNames: (body.opposingParties || []).map((p) => p?.name).filter(Boolean),
    relatedNames: (body.relatedParties || []).map((p) => p?.name).filter(Boolean),
  };
}

// ── POST /matters/conflict-check ─────────────────────────────────────────
exports.conflictCheck = async (req, res, next) => {
  try {
    const hits = await runConflictCheck(req.companyId, namesFrom(req.body), mongoose.isValidObjectId(req.body.excludeMatterId) ? req.body.excludeMatterId : undefined);
    res.status(200).json({ success: true, data: { hits, result: hits.some((h) => h.severity !== 'low') ? 'potential_conflict' : 'clear' } });
  } catch (err) { next(err); }
};

// ── GET /matters ─────────────────────────────────────────────────────────
exports.getMatters = async (req, res, next) => {
  try {
    const { status, practiceArea, search, page = 1, limit = 25 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (practiceArea) filter.practiceArea = practiceArea;
    if (search) {
      const re = new RegExp(escapeRe(search), 'i');
      filter.$or = [{ title: re }, { matterNumber: re }, { 'client.name': re }, { 'court.suitNumber': re }, { 'opposingParties.name': re }];
    }
    const lim = Math.min(100, Number(limit) || 25);
    const [matters, total, statusCounts] = await Promise.all([
      Matter.find(filter).sort({ updatedAt: -1 }).skip((Number(page) - 1) * lim).limit(lim)
        .select('-keyDates.reminded7d -keyDates.reminded1d').populate('responsibleLawyer', 'name').lean(),
      Matter.countDocuments(filter),
      Matter.aggregate([{ $match: { companyId: oid(req.companyId) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const totals = await entryTotals(req.companyId, matters.map((m) => m._id));
    const now = Date.now();
    const data = matters.map((m) => ({
      ...m,
      totals: totals.get(String(m._id)) || { unbilledTime: 0, unbilledExpenses: 0, unbilledMinutes: 0, billed: 0 },
      nextDate: (m.keyDates || []).filter((d) => !d.done && new Date(d.date).getTime() >= now - DAY_MS)
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null,
    }));
    res.status(200).json({ success: true, data, statusCounts, pagination: { total, page: Number(page), limit: lim } });
  } catch (err) { next(err); }
};

// ── POST /matters ────────────────────────────────────────────────────────
exports.createMatter = async (req, res, next) => {
  try {
    const body = await sanitizeTeam(req.companyId, pick(req.body, MATTER_EDITABLE_FIELDS));
    if (!body.title?.trim()) return next(new AppError('Matter title is required.', 400));
    if (!body.client?.name?.trim()) return next(new AppError('Client name is required.', 400));
    if (body.billing && !body.billing.currency) {
      const Company = require('../models/Company');
      const c = await Company.findById(req.companyId).select('defaultCurrency').lean();
      body.billing.currency = c?.defaultCurrency || 'NGN';
    }

    const hits = await runConflictCheck(req.companyId, namesFrom(body));
    const potential = hits.some((h) => h.severity !== 'low');
    if (potential && !req.body.conflictWaived) {
      return res.status(409).json({
        success: false, code: 'CONFLICT_CHECK',
        message: 'Possible conflict of interest found. Review the matches, then confirm to open the matter anyway.',
        data: { hits },
      });
    }

    let matter;
    for (let i = 0; i < 5 && !matter; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        matter = await Matter.create({
          ...body,
          keyDates: (req.body.keyDates || []).map((d) => pick(d, KEY_DATE_FIELDS)).filter((d) => d.title && d.date),
          companyId: req.companyId,
          // eslint-disable-next-line no-await-in-loop
          matterNumber: await nextMatterNumber(req.companyId),
          responsibleLawyer: body.responsibleLawyer || req.user._id,
          createdBy: req.user._id,
          conflictCheck: {
            checkedAt: new Date(), checkedBy: req.user._id, hits: hits.length,
            result: potential ? 'waived' : 'clear',
            notes: potential ? String(req.body.conflictNotes || 'Potential conflict reviewed and waived.').slice(0, 2000) : undefined,
          },
        });
      } catch (err) {
        if (!(err.code === 11000 && /matterNumber/.test(err.message)) || i === 4) throw err;
      }
    }
    res.status(201).json({ success: true, data: matter });
  } catch (err) { next(err); }
};

// ── GET /matters/:id ─────────────────────────────────────────────────────
exports.getMatter = async (req, res, next) => {
  try {
    const matter = await Matter.findOne({ _id: (await findMatter(req))._id })
      .populate('responsibleLawyer', 'name email').populate('team', 'name email').lean();
    const [totals, invoices] = await Promise.all([
      entryTotals(req.companyId, [matter._id]),
      Invoice.find({ companyId: req.companyId, matterId: matter._id })
        .select('invoiceNumber status total currency issuedAt dueAt paidAt').sort({ createdAt: -1 }).lean(),
    ]);
    const outstanding = invoices.filter((i) => ['draft', 'sent', 'viewed', 'partial', 'overdue'].includes(i.status))
      .reduce((s, i) => s + i.total, 0);
    res.status(200).json({
      success: true,
      data: {
        ...matter,
        totals: { ...(totals.get(String(matter._id)) || { unbilledTime: 0, unbilledExpenses: 0, unbilledMinutes: 0, billed: 0 }), outstanding: round2(outstanding) },
        invoices,
      },
    });
  } catch (err) { next(err); }
};

// ── PUT /matters/:id ─────────────────────────────────────────────────────
exports.updateMatter = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const update = await sanitizeTeam(req.companyId, pick(req.body, MATTER_EDITABLE_FIELDS));
    if (update.responsibleLawyer === undefined) delete update.responsibleLawyer;
    if (update.title !== undefined && !String(update.title).trim()) return next(new AppError('Matter title is required.', 400));
    if (update.client && !update.client.name?.trim()) return next(new AppError('Client name is required.', 400));
    if (update.status && update.status !== matter.status) {
      if (update.status === 'closed') {
        if (matter.trustBalance > 0) {
          return next(new AppError('Return or apply the client\'s trust balance before closing this matter.', 400));
        }
        matter.closedAt = new Date();
      } else if (matter.status === 'closed') {
        matter.closedAt = undefined;
      }
    }
    Object.assign(matter, update);
    await matter.save();
    res.status(200).json({ success: true, data: matter });
  } catch (err) { next(err); }
};

// ── DELETE /matters/:id ──────────────────────────────────────────────────
// Only a matter with no money history can be deleted; anything else should
// be closed instead so the financial record survives.
exports.deleteMatter = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const [trust, invoices, billed] = await Promise.all([
      TrustTransaction.exists({ companyId: req.companyId, matterId: matter._id }),
      Invoice.exists({ companyId: req.companyId, matterId: matter._id }),
      MatterEntry.exists({ companyId: req.companyId, matterId: matter._id, invoiceId: { $ne: null } }),
    ]);
    if (trust || invoices || billed) {
      return next(new AppError('This matter has invoices or trust transactions — close it instead of deleting it.', 400));
    }
    await MatterEntry.deleteMany({ companyId: req.companyId, matterId: matter._id });
    await matter.deleteOne();
    res.status(200).json({ success: true, message: 'Matter deleted.' });
  } catch (err) { next(err); }
};

// ── Time & expenses ──────────────────────────────────────────────────────
exports.getEntries = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const filter = { companyId: req.companyId, matterId: matter._id };
    if (req.query.unbilled === 'true') filter.invoiceId = null;
    const entries = await MatterEntry.find(filter).sort({ date: -1, createdAt: -1 }).limit(500)
      .populate('userId', 'name').populate('invoiceId', 'invoiceNumber status').lean();
    res.status(200).json({ success: true, data: entries });
  } catch (err) { next(err); }
};

function entryFields(body, matter) {
  const kind = body.kind === 'expense' ? 'expense' : 'time';
  const base = {
    kind,
    date: body.date ? new Date(body.date) : new Date(),
    description: String(body.description || '').trim(),
    billable: body.billable !== false && matter.billing?.method !== 'pro_bono',
  };
  if (kind === 'time') {
    const minutes = body.minutes != null ? Number(body.minutes) : Math.round(Number(body.hours || 0) * 60);
    return { ...base, minutes, rate: body.rate != null ? Number(body.rate) : (matter.billing?.hourlyRate || 0) };
  }
  return { ...base, quantity: body.quantity != null ? Number(body.quantity) : 1, unitCost: Number(body.unitCost ?? body.amount ?? 0) };
}

exports.createEntry = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    if (matter.status === 'closed') return next(new AppError('Reopen this matter before logging time or expenses.', 400));
    const fields = entryFields(req.body, matter);
    if (!fields.description) return next(new AppError('Description is required.', 400));
    if (fields.kind === 'time' && !(fields.minutes > 0)) return next(new AppError('Enter the time spent.', 400));
    const entry = await MatterEntry.create({ ...fields, companyId: req.companyId, matterId: matter._id, userId: req.user._id });
    matter.updatedAt = new Date();
    await matter.save();
    res.status(201).json({ success: true, data: entry });
  } catch (err) { next(err); }
};

async function findUnbilledEntry(req) {
  if (!mongoose.isValidObjectId(req.params.entryId)) throw new AppError('Entry not found.', 404);
  const entry = await MatterEntry.findOne({ _id: req.params.entryId, companyId: req.companyId });
  if (!entry) throw new AppError('Entry not found.', 404);
  if (entry.invoiceId) throw new AppError('This entry is already on an invoice — cancel that invoice to change it.', 400);
  return entry;
}

exports.updateEntry = async (req, res, next) => {
  try {
    const entry = await findUnbilledEntry(req);
    const matter = await findMatter(req, entry.matterId);
    const fields = entryFields({ ...entry.toObject(), ...req.body, kind: entry.kind }, matter);
    Object.assign(entry, fields);
    await entry.save();
    res.status(200).json({ success: true, data: entry });
  } catch (err) { next(err); }
};

exports.deleteEntry = async (req, res, next) => {
  try {
    const entry = await findUnbilledEntry(req);
    await entry.deleteOne();
    res.status(200).json({ success: true, message: 'Entry deleted.' });
  } catch (err) { next(err); }
};

// ── Key dates (hearings, filing deadlines, limitation dates) ─────────────
exports.addKeyDate = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const d = pick(req.body, KEY_DATE_FIELDS);
    if (!d.title || !d.date) return next(new AppError('Title and date are required.', 400));
    matter.keyDates.push(d);
    await matter.save();
    res.status(201).json({ success: true, data: matter.keyDates[matter.keyDates.length - 1] });
  } catch (err) { next(err); }
};

exports.updateKeyDate = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const d = matter.keyDates.id(req.params.dateId);
    if (!d) return next(new AppError('Date not found.', 404));
    const update = pick(req.body, KEY_DATE_FIELDS);
    if (update.date && new Date(update.date).getTime() !== new Date(d.date).getTime()) {
      d.reminded7d = false; d.reminded1d = false; // rescheduled → remind again
    }
    Object.assign(d, update);
    await matter.save();
    res.status(200).json({ success: true, data: d });
  } catch (err) { next(err); }
};

exports.deleteKeyDate = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const d = matter.keyDates.id(req.params.dateId);
    if (!d) return next(new AppError('Date not found.', 404));
    d.deleteOne();
    await matter.save();
    res.status(200).json({ success: true, message: 'Date removed.' });
  } catch (err) { next(err); }
};

// ── GET /matters/calendar?days=30 — every open matter's upcoming dates ──
exports.getCalendar = async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const from = new Date(Date.now() - DAY_MS);
    const to = new Date(Date.now() + days * DAY_MS);
    const rows = await Matter.aggregate([
      { $match: { companyId: oid(req.companyId), status: { $ne: 'closed' } } },
      { $unwind: '$keyDates' },
      { $match: { 'keyDates.done': false, 'keyDates.date': { $gte: from, $lte: to } } },
      { $sort: { 'keyDates.date': 1 } },
      { $project: { matterNumber: 1, title: 1, 'client.name': 1, 'court.name': 1, 'court.suitNumber': 1, keyDate: '$keyDates' } },
    ]);
    res.status(200).json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── Client trust ledger ──────────────────────────────────────────────────
// Debits go through one atomic, guarded update so the balance can never go
// negative even under concurrent requests.
async function postTrust(matter, { type, amount, description, reference, invoiceId, date }, userId) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new AppError('Amount must be greater than zero.', 400);
  const delta = type === 'deposit' ? amt : -amt;
  const guard = delta < 0 ? { trustBalance: { $gte: amt } } : {};
  const updated = await Matter.findOneAndUpdate(
    { _id: matter._id, companyId: matter.companyId, ...guard },
    { $inc: { trustBalance: delta } },
    { new: true },
  );
  if (!updated) {
    throw new AppError(`Insufficient trust funds. Available: ${matter.billing?.currency || 'NGN'} ${round2(matter.trustBalance).toLocaleString()}.`, 400);
  }
  // Float drift guard — the stored balance is always rounded to cents.
  const balanceAfter = round2(updated.trustBalance);
  if (balanceAfter !== updated.trustBalance) await Matter.updateOne({ _id: matter._id }, { trustBalance: balanceAfter });

  return TrustTransaction.create({
    companyId: matter.companyId, matterId: matter._id, type, amount: amt,
    currency: matter.billing?.currency || 'NGN', date: date ? new Date(date) : new Date(),
    description, reference, invoiceId, balanceAfter, createdBy: userId,
  });
}

exports.getTrust = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const ledger = await TrustTransaction.find({ companyId: req.companyId, matterId: matter._id })
      .sort({ createdAt: -1 }).populate('invoiceId', 'invoiceNumber').populate('createdBy', 'name').lean();
    res.status(200).json({ success: true, data: { balance: matter.trustBalance, currency: matter.billing?.currency || 'NGN', ledger } });
  } catch (err) { next(err); }
};

exports.createTrustTransaction = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const { type } = req.body;
    if (!['deposit', 'disbursement', 'refund'].includes(type)) {
      return next(new AppError('Type must be deposit, disbursement or refund. Apply trust to an invoice from the invoice step.', 400));
    }
    const txn = await postTrust(matter, {
      type, amount: req.body.amount,
      description: String(req.body.description || '').slice(0, 500),
      reference: String(req.body.reference || '').slice(0, 100),
      date: req.body.date,
    }, req.user._id);
    res.status(201).json({ success: true, data: txn });
  } catch (err) { next(err); }
};

// ── POST /matters/:id/invoice ────────────────────────────────────────────
// Rolls unbilled time + disbursements (all, or the chosen entryIds) into one
// invoice, optionally paying it from the client's trust balance. Flat-fee
// matters may bill the fee as a line instead of / as well as entries.
exports.invoiceMatter = async (req, res, next) => {
  try {
    const matter = await findMatter(req);
    const filter = { companyId: req.companyId, matterId: matter._id, invoiceId: null, billable: true };
    if (Array.isArray(req.body.entryIds) && req.body.entryIds.length) {
      filter._id = { $in: req.body.entryIds.filter((id) => mongoose.isValidObjectId(id)) };
    }
    const entries = await MatterEntry.find(filter).sort({ date: 1 });

    const items = entries.map((e) => (e.kind === 'time'
      ? { description: `${new Date(e.date).toISOString().slice(0, 10)} — ${e.description} (${round2(e.minutes / 60)}h @ ${e.rate}/h)`, quantity: round2(e.minutes / 60), unitPrice: e.rate, total: e.amount }
      : { description: `${new Date(e.date).toISOString().slice(0, 10)} — Disbursement: ${e.description}`, quantity: e.quantity ?? 1, unitPrice: e.unitCost, total: e.amount }));
    const flatFee = round2(req.body.flatFee ?? (req.body.includeFlatFee ? matter.billing?.flatFee : 0));
    if (flatFee > 0) items.unshift({ description: `Professional fee — ${matter.title}`, quantity: 1, unitPrice: flatFee, total: flatFee });
    if (!items.length) return next(new AppError('Nothing to bill — there are no unbilled entries on this matter.', 400));

    const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
    const taxRate = Math.min(100, Math.max(0, Number(req.body.taxRate) || 0)); // e.g. 7.5 VAT
    const tax = round2(subtotal * taxRate / 100);
    const discount = Math.min(subtotal, round2(req.body.discount || 0));
    const total = round2(subtotal + tax - discount);
    const currency = matter.billing?.currency || 'NGN';
    const { exchangeRate, ngnEquivalent } = await currencyFieldsFor(currency, total);
    const dueInDays = Math.min(365, Math.max(0, Number(req.body.dueInDays) || 14));
    const now = new Date();

    const invoice = await createWithNumber({
      companyId: req.companyId,
      matterId: matter._id,
      matterNumber: matter.matterNumber,
      customer: { name: matter.client.name, email: matter.client.email, phone: matter.client.phone, address: matter.client.address },
      items, subtotal, tax, discount, total, currency, exchangeRate, ngnEquivalent,
      status: 'draft',
      issuedAt: now,
      dueAt: new Date(now.getTime() + dueInDays * DAY_MS),
      notes: [
        `Matter ${matter.matterNumber}: ${matter.title}.`,
        matter.court?.suitNumber && `Suit No. ${matter.court.suitNumber}.`,
        taxRate ? `Tax at ${taxRate}%.` : null,
        req.body.notes,
      ].filter(Boolean).join(' ').slice(0, 2000),
      createdBy: req.user._id,
    });

    // Claim the entries for this invoice. The invoiceId: null guard means a
    // concurrent second invoice can't claim the same work.
    const claimed = await MatterEntry.updateMany({ _id: { $in: entries.map((e) => e._id) }, invoiceId: null }, { invoiceId: invoice._id });
    if (claimed.modifiedCount !== entries.length) {
      await MatterEntry.updateMany({ invoiceId: invoice._id }, { invoiceId: null });
      await Invoice.deleteOne({ _id: invoice._id });
      return next(new AppError('Some of these entries were just billed elsewhere — refresh and try again.', 409));
    }

    // Optionally settle from trust, up to what's available.
    let trustApplied = 0;
    if (req.body.applyTrust && matter.trustBalance > 0) {
      trustApplied = round2(Math.min(matter.trustBalance, total));
      try {
        await postTrust(matter, { type: 'invoice_payment', amount: trustApplied, description: `Applied to invoice ${invoice.invoiceNumber}`, invoiceId: invoice._id }, req.user._id);
        invoice.status = trustApplied >= total ? 'paid' : 'partial';
        if (invoice.status === 'paid') invoice.paidAt = now;
        invoice.notes = `${invoice.notes} ${matter.billing?.currency || 'NGN'} ${trustApplied.toLocaleString()} paid from client trust account.`.trim();
        await invoice.save();
      } catch (e) { trustApplied = 0; } // balance moved underneath us — leave the invoice unpaid
    }

    require('../utils/cache').del(`dashboard_${req.companyId}`);
    res.status(201).json({ success: true, data: { invoice, entriesBilled: entries.length, trustApplied } });
  } catch (err) { next(err); }
};

// ── GET /matters/reports/utilization — billable hours per lawyer ─────────
exports.getUtilization = async (req, res, next) => {
  try {
    const days = Math.min(366, Math.max(1, Number(req.query.days) || 30));
    const from = new Date(Date.now() - days * DAY_MS);
    const rows = await MatterEntry.aggregate([
      { $match: { companyId: oid(req.companyId), kind: 'time', date: { $gte: from } } },
      { $group: {
        _id: '$userId',
        minutes: { $sum: '$minutes' },
        billableMinutes: { $sum: { $cond: ['$billable', '$minutes', 0] } },
        value: { $sum: { $cond: ['$billable', '$amount', 0] } },
        billedValue: { $sum: { $cond: [{ $and: ['$billable', { $ne: ['$invoiceId', null] }] }, '$amount', 0] } },
      } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, 'Unknown'] }, minutes: 1, billableMinutes: 1, value: 1, billedValue: 1 } },
      { $sort: { billableMinutes: -1 } },
    ]);
    res.status(200).json({ success: true, data: rows, days });
  } catch (err) { next(err); }
};

exports.runConflictCheck = runConflictCheck;
exports.postTrust = postTrust;
