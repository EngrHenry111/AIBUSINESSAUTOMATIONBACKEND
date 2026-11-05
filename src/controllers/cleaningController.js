'use strict';

// Cleaning services: services and pricing, booking and scheduling visits,
// assigning the team, the on-site checklist and photos, payments, and
// repeating cleans that book themselves.

const fs = require('fs');
const mongoose = require('mongoose');
const CleaningJob = require('../models/CleaningJob');
const Company = require('../models/Company');
const User = require('../models/User');
const { cloudinary } = require('../config/cloudinary');
const { AppError } = require('../middleware/errorMiddleware');
const { settingsFor } = require('../utils/serviceDefaults');
const { recordCustomerTransaction } = require('../utils/customerSync');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const {
  round2, isManager, lagosDay, nextNumber, cleanCustomer, cleanPayment, addPayment, emailCustomer, DAY_MS,
} = require('../utils/serviceJobs');

const PROPERTY_TYPES = ['flat', 'duplex', 'bungalow', 'terrace', 'office', 'shop', 'other'];
const FREQUENCIES = { none: 0, weekly: 7, biweekly: 14, monthly: 0 };
const NEXT = { scheduled: ['on_the_way', 'in_progress'], on_the_way: ['in_progress', 'scheduled'], in_progress: ['completed'] };
const STATUS_LABEL = { scheduled: 'Scheduled', on_the_way: 'On the way', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const MAX_PHOTOS = 30;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

function settingsView(s) {
  const c = s.cleaning;
  return {
    services: c.services.map((x) => ({
      id: String(x._id), name: x.name, description: x.description || '', basePrice: x.basePrice, perBedroom: x.perBedroom,
      perBathroom: x.perBathroom, hours: x.hours, checklist: x.checklist, active: x.active !== false,
    })),
    extras: c.extras.map((x) => ({ name: x.name, price: x.price })),
    transportFee: c.transportFee || 0,
  };
}

// The price of a visit, worked out the same way every time.
function quote(cfg, { service, property, extras, discount }) {
  const svc = cfg.services.find((x) => x.name === service && x.active !== false);
  if (!svc) throw new AppError('Choose a service from your list.', 400);
  const bedrooms = Math.max(0, Math.min(50, Math.round(Number(property?.bedrooms) || 0)));
  const bathrooms = Math.max(0, Math.min(50, Math.round(Number(property?.bathrooms) || 0)));
  const extraMap = new Map(cfg.extras.map((e) => [e.name, e.price]));
  const chosen = [];
  for (const e of Array.isArray(extras) ? extras : []) {
    if (!extraMap.has(e?.name)) throw new AppError(`"${e?.name}" is not one of your extras.`, 400);
    const quantity = Math.max(1, Math.min(50, Math.round(Number(e.quantity) || 1)));
    chosen.push({ name: e.name, price: extraMap.get(e.name), quantity });
  }
  const base = round2(svc.basePrice);
  const rooms = round2(bedrooms * svc.perBedroom + bathrooms * svc.perBathroom);
  const extrasTotal = round2(chosen.reduce((t, e) => t + e.price * e.quantity, 0));
  const transport = round2(cfg.transportFee || 0);
  const gross = round2(base + rooms + extrasTotal + transport);
  const disc = round2(Math.max(0, Number(discount) || 0));
  if (disc > gross) throw new AppError('The discount is more than the price.', 400);
  return {
    svc, bedrooms, bathrooms, extras: chosen,
    price: { base, rooms, extras: extrasTotal, transport, discount: disc, total: round2(gross - disc) },
  };
}

function jobView(j) {
  const balance = Math.max(0, round2(j.price.total - j.amountPaid));
  const done = j.checklist.filter((t) => t.done).length;
  return {
    id: String(j._id), jobNumber: j.jobNumber, customer: j.customer, address: j.address, area: j.area || '', landmark: j.landmark || '',
    accessNotes: j.accessNotes || '', property: j.property, service: j.service, extras: j.extras.map((e) => ({ name: e.name, price: e.price, quantity: e.quantity })),
    scheduledAt: j.scheduledAt, hours: j.hours, endsAt: new Date(new Date(j.scheduledAt).getTime() + j.hours * 3600 * 1000),
    team: j.team.map((t) => ({ userId: t.userId ? String(t.userId) : null, name: t.name })),
    checklist: j.checklist.map((t) => ({ task: t.task, done: t.done, doneBy: t.doneBy || '' })),
    progress: { done, total: j.checklist.length },
    photos: j.photos.map((p) => ({ url: p.url, kind: p.kind, at: p.at, byName: p.byName || '' })),
    price: j.price, amountPaid: j.amountPaid, balance, currency: j.currency,
    paymentStatus: j.amountPaid <= 0 ? 'unpaid' : balance > 0 ? 'part_paid' : 'paid',
    payments: j.payments.map((p) => ({ amount: p.amount, method: p.method, at: p.at, byName: p.byName, note: p.note || '' })),
    status: j.status, statusLabel: STATUS_LABEL[j.status], startedAt: j.startedAt, completedAt: j.completedAt, cancelReason: j.cancelReason || '',
    recurrence: j.recurrence, nextJobId: j.nextJobId ? String(j.nextJobId) : null,
    timeline: j.timeline, notes: j.notes || '', createdAt: j.createdAt,
  };
}

const onTeam = (job, user) => job.team.some((t) => t.userId && String(t.userId) === String(user._id));

async function findJob(req, { forTeam = true } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Job not found.', 404);
  const j = await CleaningJob.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!j) throw new AppError('Job not found.', 404);
  if (!isManager(req.user) && !(forTeam && onTeam(j, req.user))) throw new AppError('Job not found.', 404);
  return j;
}

async function teamFrom(companyId, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (list.length > 20) throw new AppError('Up to 20 people on one job.', 400);
  const users = await User.find({ _id: { $in: list }, companyId, status: { $ne: 'inactive' } }).select('name').lean();
  if (users.length !== list.length) throw new AppError('One of the team members is not on your staff list.', 400);
  return users.map((u) => ({ userId: u._id, name: u.name }));
}

// Other visits the same people already have at overlapping times.
async function clashes(companyId, team, start, hours, exceptId) {
  if (!team.length) return [];
  const end = new Date(start.getTime() + hours * 3600 * 1000);
  const rows = await CleaningJob.find({
    companyId, _id: { $ne: exceptId }, status: { $in: ['scheduled', 'on_the_way', 'in_progress'] },
    'team.userId': { $in: team.map((t) => t.userId) },
    scheduledAt: { $lt: end, $gte: new Date(start.getTime() - 24 * 3600 * 1000) },
  }).select('jobNumber scheduledAt hours team').lean();
  const out = [];
  for (const r of rows) {
    const rEnd = new Date(new Date(r.scheduledAt).getTime() + r.hours * 3600 * 1000);
    if (rEnd <= start) continue;
    const who = r.team.filter((t) => team.some((x) => String(x.userId) === String(t.userId))).map((t) => t.name);
    out.push(`${who.join(', ')} already ${who.length > 1 ? 'have' : 'has'} ${r.jobNumber} at ${new Date(r.scheduledAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}`);
  }
  return out;
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
    const num = (v, label, max = 1e8) => {
      const n = Number(v ?? 0);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError(`Check the ${label}.`, 400);
      return round2(n);
    };
    if (b.services !== undefined) {
      if (!Array.isArray(b.services) || b.services.length > 50) return next(new AppError('Up to 50 services.', 400));
      const seen = new Set();
      const services = [];
      for (const x of b.services) {
        const name = String(x?.name || '').trim().slice(0, 80);
        if (!name) continue;
        if (seen.has(name.toLowerCase())) return next(new AppError(`"${name}" is listed twice.`, 400));
        seen.add(name.toLowerCase());
        services.push({
          name, description: String(x.description || '').trim().slice(0, 300),
          basePrice: num(x.basePrice, `base price for ${name}`), perBedroom: num(x.perBedroom, `bedroom price for ${name}`),
          perBathroom: num(x.perBathroom, `bathroom price for ${name}`),
          hours: Math.max(0.5, Math.min(48, Number(x.hours) || 3)),
          checklist: (Array.isArray(x.checklist) ? x.checklist : []).map((t) => String(t || '').trim().slice(0, 150)).filter(Boolean).slice(0, 60),
          active: x.active !== false,
        });
      }
      if (!services.length) return next(new AppError('Keep at least one service.', 400));
      s.set('cleaning.services', services);
    }
    if (b.extras !== undefined) {
      if (!Array.isArray(b.extras) || b.extras.length > 60) return next(new AppError('Up to 60 extras.', 400));
      const seen = new Set();
      const extras = [];
      for (const x of b.extras) {
        const name = String(x?.name || '').trim().slice(0, 80);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        extras.push({ name, price: num(x.price, `price for ${name}`) });
      }
      s.set('cleaning.extras', extras);
    }
    if (b.transportFee !== undefined) s.set('cleaning.transportFee', num(b.transportFee, 'transport fee'));
    await s.save();
    res.json({ success: true, data: settingsView(s) });
  } catch (err) { next(err); }
};

// Everyone who can be sent on a job, including staff with no login.
exports.getTeam = async (req, res, next) => {
  try {
    const users = await User.find({ companyId: req.companyId, status: { $ne: 'inactive' } }).select('name role noLogin').sort({ name: 1 }).lean();
    res.json({ success: true, data: users.map((u) => ({ id: String(u._id), name: u.name, role: u.role, noLogin: Boolean(u.noLogin) })) });
  } catch (err) { next(err); }
};

// ── Jobs ─────────────────────────────────────────────────────────────────
exports.listJobs = async (req, res, next) => {
  try {
    const from = lagosDay(req.query.from).start;
    const to = req.query.to ? lagosDay(req.query.to).end : new Date(from.getTime() + 7 * DAY_MS);
    if (to - from > 93 * DAY_MS) return next(new AppError('Pick up to 3 months at a time.', 400));
    const filter = { companyId: req.companyId, scheduledAt: { $gte: from, $lt: to } };
    const manager = isManager(req.user);
    if (!manager || req.query.mine === '1') filter['team.userId'] = req.user._id;
    else if (req.query.cleaner && mongoose.isValidObjectId(req.query.cleaner)) filter['team.userId'] = oid(req.query.cleaner);
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    const jobs = await CleaningJob.find(filter).sort({ scheduledAt: 1 }).limit(1000);
    const live = jobs.filter((j) => j.status !== 'cancelled');
    const owedAgg = manager ? await CleaningJob.aggregate([
      { $match: { companyId: oid(req.companyId), status: 'completed', $expr: { $gt: ['$price.total', { $add: ['$amountPaid', 0.009] }] } } },
      { $group: { _id: null, owed: { $sum: { $subtract: ['$price.total', '$amountPaid'] } }, count: { $sum: 1 } } },
    ]) : [];
    res.json({
      success: true,
      data: {
        scope: manager && req.query.mine !== '1' ? 'everyone' : 'mine',
        jobs: jobs.map(jobView),
        summary: {
          jobs: live.length,
          completed: live.filter((j) => j.status === 'completed').length,
          value: round2(live.reduce((t, j) => t + j.price.total, 0)),
          collected: round2(live.reduce((t, j) => t + j.amountPaid, 0)),
          ...(manager && { owedAfterCompletion: round2(owedAgg[0]?.owed || 0), owingJobs: owedAgg[0]?.count || 0 }),
        },
      },
    });
  } catch (err) { next(err); }
};

exports.createJob = async (req, res, next) => {
  try {
    const b = req.body || {};
    const customer = cleanCustomer(b.customer, { requirePhone: true });
    const address = String(b.address || '').trim().slice(0, 400);
    if (!address) return next(new AppError('Add the address of the place to be cleaned.', 400));
    const scheduledAt = new Date(b.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) return next(new AppError('Choose the date and time of the visit.', 400));
    if (scheduledAt < new Date(Date.now() - 2 * DAY_MS)) return next(new AppError('That date is in the past.', 400));
    const recurrence = Object.prototype.hasOwnProperty.call(FREQUENCIES, b.recurrence) ? b.recurrence : 'none';

    const s = await settingsFor(req.companyId);
    const q = quote(s.cleaning, b);
    const hours = Math.max(0.5, Math.min(48, Number(b.hours) || q.svc.hours));
    const team = await teamFrom(req.companyId, b.team);
    const company = await companyOf(req.companyId);
    const job = await CleaningJob.create({
      companyId: req.companyId,
      jobNumber: await nextNumber(req.companyId, 'cleaning', 'CL-', 5),
      customer, address,
      area: String(b.area || '').trim().slice(0, 100), landmark: String(b.landmark || '').trim().slice(0, 200),
      accessNotes: String(b.accessNotes || '').trim().slice(0, 500),
      property: { type: PROPERTY_TYPES.includes(b.property?.type) ? b.property.type : 'flat', bedrooms: q.bedrooms, bathrooms: q.bathrooms },
      service: q.svc.name, extras: q.extras, scheduledAt, hours, team,
      checklist: [...q.svc.checklist, ...q.extras.map((e) => e.name)].map((task) => ({ task })),
      price: q.price, currency: company?.defaultCurrency || 'NGN',
      recurrence, seriesId: recurrence !== 'none' ? new mongoose.Types.ObjectId() : undefined,
      timeline: [{ status: 'scheduled', note: 'Booked', byName: req.user.name || '' }],
      notes: String(b.notes || '').trim().slice(0, 1000) || undefined,
      createdBy: req.user._id,
    });
    recordCustomerTransaction({ companyId: req.companyId, customer, amount: q.price.total, countsAsOrder: true, userId: req.user._id }).catch(() => {});
    const warnings = await clashes(req.companyId, team, scheduledAt, hours, job._id);
    cache.del(`dashboard_${req.companyId}`);
    res.status(201).json({ success: true, warnings, data: jobView(job) });
  } catch (err) { next(err); }
};

exports.getJob = async (req, res, next) => {
  try {
    const [j, company] = await Promise.all([findJob(req), companyOf(req.companyId)]);
    res.json({
      success: true,
      data: { ...jobView(j), business: company ? { name: company.companyName, phone: company.profile?.phone || '', address: company.profile?.address || '', logo: company.logo || '' } : null },
    });
  } catch (err) { next(err); }
};

exports.updateJob = async (req, res, next) => {
  try {
    const j = await findJob(req, { forTeam: false });
    if (['completed', 'cancelled'].includes(j.status)) return next(new AppError(`This job is ${j.status}.`, 400));
    const b = req.body || {};
    const notes = [];
    if (b.scheduledAt !== undefined) {
      const d = new Date(b.scheduledAt);
      if (Number.isNaN(d.getTime())) return next(new AppError('Check the date and time.', 400));
      if (+d !== +j.scheduledAt) notes.push(`Moved to ${d.toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })}`);
      j.scheduledAt = d;
    }
    if (b.hours !== undefined) j.hours = Math.max(0.5, Math.min(48, Number(b.hours) || j.hours));
    if (b.team !== undefined) {
      j.team = await teamFrom(req.companyId, b.team);
      notes.push(`Team: ${j.team.map((t) => t.name).join(', ') || 'nobody'}`);
    }
    for (const k of ['address', 'area', 'landmark', 'accessNotes', 'notes']) {
      if (b[k] !== undefined) j[k] = String(b[k] || '').trim().slice(0, k === 'notes' ? 1000 : 400);
    }
    if (!j.address) return next(new AppError('The address can\'t be empty.', 400));
    if (b.customer?.phone !== undefined) j.customer.phone = String(b.customer.phone || '').trim().slice(0, 30);
    if (b.customer?.email !== undefined) j.customer.email = String(b.customer.email || '').trim().toLowerCase().slice(0, 200);
    if (b.discount !== undefined || b.extras !== undefined || b.property !== undefined) {
      const s = await settingsFor(req.companyId);
      const q = quote(s.cleaning, {
        service: j.service,
        property: b.property !== undefined ? b.property : j.property,
        extras: b.extras !== undefined ? b.extras : j.extras,
        discount: b.discount !== undefined ? b.discount : j.price.discount,
      });
      if (q.price.total + 0.009 < j.amountPaid) return next(new AppError('The new price is less than what has already been paid.', 400));
      j.price = q.price; j.extras = q.extras;
      j.property = { type: PROPERTY_TYPES.includes(b.property?.type) ? b.property.type : j.property.type, bedrooms: q.bedrooms, bathrooms: q.bathrooms };
      notes.push(`Price now ${q.price.total.toLocaleString('en-NG')}`);
    }
    if (b.recurrence !== undefined && Object.prototype.hasOwnProperty.call(FREQUENCIES, b.recurrence)) {
      j.recurrence = b.recurrence;
      if (b.recurrence !== 'none' && !j.seriesId) j.seriesId = new mongoose.Types.ObjectId();
    }
    if (notes.length) j.timeline.push({ status: 'note', note: notes.join('. '), byName: req.user.name || '' });
    await j.save();
    const warnings = await clashes(req.companyId, j.team, j.scheduledAt, j.hours, j._id);
    res.json({ success: true, warnings, data: jobView(j) });
  } catch (err) { next(err); }
};

function nextVisitDate(date, recurrence) {
  const d = new Date(date);
  if (recurrence === 'monthly') { d.setMonth(d.getMonth() + 1); return d; }
  return new Date(d.getTime() + FREQUENCIES[recurrence] * DAY_MS);
}

// Books the next visit of a repeating clean (once per visit).
async function bookNext(job, user) {
  if (job.recurrence === 'none' || job.nextJobId) return null;
  const next = await CleaningJob.create({
    companyId: job.companyId,
    jobNumber: await nextNumber(job.companyId, 'cleaning', 'CL-', 5),
    customer: job.customer, address: job.address, area: job.area, landmark: job.landmark, accessNotes: job.accessNotes,
    property: job.property, service: job.service, extras: job.extras, hours: job.hours, team: job.team,
    scheduledAt: nextVisitDate(job.scheduledAt, job.recurrence),
    checklist: job.checklist.map((t) => ({ task: t.task })),
    price: job.price, currency: job.currency, recurrence: job.recurrence, seriesId: job.seriesId,
    timeline: [{ status: 'scheduled', note: `Repeat of ${job.jobNumber}`, byName: user.name || '' }],
    notes: job.notes, createdBy: user._id,
  });
  await CleaningJob.updateOne({ _id: job._id }, { nextJobId: next._id });
  return next;
}

exports.setStatus = async (req, res, next) => {
  try {
    const j = await findJob(req);
    const to = req.body?.status;
    if (!(NEXT[j.status] || []).includes(to)) return next(new AppError(`A ${STATUS_LABEL[j.status].toLowerCase()} job can't be moved to ${STATUS_LABEL[to] || to}.`, 400));
    const update = { status: to };
    if (to === 'in_progress' && !j.startedAt) update.startedAt = new Date();
    if (to === 'completed') update.completedAt = new Date();
    const saved = await CleaningJob.findOneAndUpdate(
      { _id: j._id, companyId: req.companyId, status: j.status },
      { $set: update, $push: { timeline: { status: to, at: new Date(), byName: req.user.name || '' } } },
      { new: true },
    );
    if (!saved) return next(new AppError('Someone else just updated this job. Refresh and try again.', 409));
    let nextJob = null;
    if (to === 'completed') {
      nextJob = await bookNext(saved, req.user).catch((e) => { logger.error(`Cleaning repeat booking failed: ${e.message}`); return null; });
      if (nextJob) saved.nextJobId = nextJob._id;
    }
    let emailed = false;
    if (to === 'on_the_way' && saved.customer.email) {
      const company = await companyOf(req.companyId);
      emailed = await emailCustomer({
        company, to: saved.customer.email, subject: `Your cleaners are on the way (${saved.jobNumber})`,
        lines: [`Hi ${saved.customer.name},`, `${saved.team.map((t) => t.name).join(', ') || 'Our team'} ${saved.team.length > 1 ? 'are' : 'is'} on the way to ${saved.address} for your ${saved.service.toLowerCase()}.`, 'See you soon!'],
      });
    }
    res.json({ success: true, emailed, nextJob: nextJob ? jobView(nextJob) : null, data: jobView(saved) });
  } catch (err) { next(err); }
};

exports.toggleTask = async (req, res, next) => {
  try {
    const j = await findJob(req);
    if (!['on_the_way', 'in_progress', 'scheduled'].includes(j.status)) return next(new AppError('The checklist can only be changed before the job is completed.', 400));
    const i = Number(req.params.index);
    if (!Number.isInteger(i) || i < 0 || i >= j.checklist.length) return next(new AppError('That task does not exist.', 404));
    const done = Boolean(req.body?.done);
    const saved = await CleaningJob.findOneAndUpdate(
      { _id: j._id, companyId: req.companyId },
      { $set: { [`checklist.${i}.done`]: done, [`checklist.${i}.doneAt`]: done ? new Date() : null, [`checklist.${i}.doneBy`]: done ? req.user.name || '' : '' } },
      { new: true },
    );
    res.json({ success: true, data: jobView(saved) });
  } catch (err) { next(err); }
};

exports.addPhotos = async (req, res, next) => {
  const files = req.files || [];
  try {
    const j = await findJob(req);
    const kind = req.body?.kind === 'after' ? 'after' : 'before';
    if (!files.length) return next(new AppError('Choose at least one photo.', 400));
    if (j.photos.length + files.length > MAX_PHOTOS) return next(new AppError(`Up to ${MAX_PHOTOS} photos per job.`, 400));
    const photos = [];
    for (const f of files) {
      let url;
      if (cloudinary) {
        const r = await cloudinary.uploader.upload(f.path, { folder: `business-ai/${req.companyId}/cleaning`, resource_type: 'image', transformation: [{ width: 1400, height: 1400, crop: 'limit', quality: 'auto' }] });
        url = r.secure_url;
      } else {
        url = `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${f.filename}`;
      }
      photos.push({ url, kind, at: new Date(), byName: req.user.name || '' });
    }
    const saved = await CleaningJob.findOneAndUpdate({ _id: j._id, companyId: req.companyId }, { $push: { photos: { $each: photos } } }, { new: true });
    res.json({ success: true, data: jobView(saved) });
  } catch (err) {
    next(err);
  } finally {
    if (cloudinary) for (const f of files) fs.unlink(f.path, () => {});
  }
};

exports.addPayment = async (req, res, next) => {
  try {
    const j = await findJob(req);
    const saved = await addPayment(CleaningJob, j, 'price.total', cleanPayment(req.body), req.user);
    cache.del(`dashboard_${req.companyId}`);
    res.json({ success: true, data: jobView(saved) });
  } catch (err) { next(err); }
};

exports.cancelJob = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) return next(new AppError('Say why the job is being cancelled.', 400));
    const j = await findJob(req, { forTeam: false });
    const saved = await CleaningJob.findOneAndUpdate(
      { _id: j._id, companyId: req.companyId, status: { $in: ['scheduled', 'on_the_way'] } },
      { $set: { status: 'cancelled', cancelReason: reason }, $push: { timeline: { status: 'cancelled', note: reason, at: new Date(), byName: req.user.name || '' } } },
      { new: true },
    );
    if (!saved) return next(new AppError('Only a job that hasn\'t started can be cancelled.', 400));
    // A skipped visit in a repeating booking: the next one still happens,
    // unless the whole booking is being stopped.
    let nextJob = null;
    if (req.body?.stopSeries) await CleaningJob.updateOne({ _id: saved._id }, { recurrence: 'none' });
    else nextJob = await bookNext(saved, req.user).catch(() => null);
    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id, action: 'cleaning_job_cancelled', resource: 'CleaningJob', resourceId: j._id,
      description: `Cancelled cleaning job ${j.jobNumber}: ${reason}`, ip: req.ip,
    });
    res.json({ success: true, nextJob: nextJob ? jobView(nextJob) : null, data: jobView(await CleaningJob.findById(saved._id)) });
  } catch (err) { next(err); }
};

exports.NEXT = NEXT;
exports._quote = quote;
