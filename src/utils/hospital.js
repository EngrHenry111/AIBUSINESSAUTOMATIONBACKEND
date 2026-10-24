'use strict';

// Shared plumbing for the hospital module: per-hospital settings, atomic
// document numbers, live updates, and the bill arithmetic every charge and
// payment goes through (desk, lab, pharmacy, wards).

const mongoose = require('mongoose');
const HospitalSettings = require('../models/HospitalSettings');
const HospitalCounter = require('../models/HospitalCounter');
const HospitalBill = require('../models/HospitalBill');
const HospitalVisit = require('../models/HospitalVisit');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TZ = () => process.env.HOSPITAL_TZ || process.env.SCHOOL_TZ || 'Africa/Lagos';

// Today in the hospital's timezone as YYYY-MM-DD.
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Settings are created lazily the first time a hospital opens the module.
async function getSettings(companyId) {
  const existing = await HospitalSettings.findOne({ companyId });
  if (existing) return existing;
  const company = await Company.findById(companyId).select('companyName profile').lean();
  try {
    return await HospitalSettings.create({
      companyId,
      hospitalName: company?.companyName,
      email: company?.profile?.email,
      phone: company?.profile?.phone,
      address: company?.profile?.address,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return HospitalSettings.findOne({ companyId }); // a parallel request created them
  }
}

// Reserves `count` consecutive numbers from a counter; returns the first.
async function reserve(companyId, key, count = 1) {
  const c = await HospitalCounter.findOneAndUpdate(
    { companyId, key }, { $inc: { seq: count } }, { upsert: true, new: true },
  ).lean();
  return c.seq - count + 1;
}

const pad = (n, w = 6) => String(n).padStart(w, '0');
const FORMATS = {
  patient: (n, s) => `${s?.patientNumberPrefix || 'PT'}/${new Date().getFullYear()}/${pad(n, 5)}`,
  visit: (n) => `V-${pad(n)}`,
  bill: (n) => `INV-${pad(n)}`,
  receipt: (n) => `RCT-${pad(n)}`,
  lab: (n) => `LAB-${pad(n)}`,
  rx: (n) => `RX-${pad(n)}`,
  admission: (n) => `ADM-${pad(n)}`,
};

async function nextNumber(companyId, kind, settings) {
  const n = await reserve(companyId, kind);
  return FORMATS[kind](n, settings);
}

// The day's queue number — starts at 1 every morning.
const nextQueueNumber = (companyId, date = todayStr()) => reserve(companyId, `queue:${date}`);

function emitHospital(io, companyId, kind, data = {}) {
  io?.to(`company:${companyId}`).emit('hospital:update', { kind, ...data, at: Date.now() });
}

// ── Bills ────────────────────────────────────────────────────────────────

// The HMO that covers this patient today, if the hospital accepts it.
function hmoFor(patient, settings) {
  const ins = patient?.insurance;
  if (!ins?.hmo) return null;
  if (ins.expiresAt && new Date(ins.expiresAt) < new Date()) return null;
  const hmo = (settings.hmos || []).find((h) => h.active !== false && h.name.toLowerCase() === ins.hmo.toLowerCase());
  return hmo ? { name: hmo.name, enrolleeId: ins.enrolleeId, coverPercent: hmo.coverPercent } : null;
}

function recalcBill(bill) {
  for (const it of bill.items) it.amount = round2((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0));
  bill.subtotal = round2(bill.items.reduce((s, it) => s + it.amount, 0));
  bill.discount = Math.min(round2(bill.discount), bill.subtotal);
  bill.total = round2(bill.subtotal - bill.discount);
  bill.hmoAmount = bill.hmo?.name ? round2((bill.total * (bill.hmo.coverPercent || 0)) / 100) : 0;
  bill.patientAmount = round2(bill.total - bill.hmoAmount);
  bill.balance = round2(bill.patientAmount - bill.amountPaid);
  if (bill.status !== 'cancelled') {
    bill.status = bill.balance <= 0.004 ? 'paid' : bill.amountPaid > 0 ? 'partial' : 'unpaid';
  }
  return bill;
}

// Load → change → save, retrying if another desk changed the bill at the
// same moment (optimistic concurrency on HospitalBill).
async function mutateBill(companyId, billId, fn) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const bill = await HospitalBill.findOne({ _id: billId, companyId });
    if (!bill) throw new AppError('Bill not found.', 404);
    // eslint-disable-next-line no-await-in-loop
    await fn(bill);
    recalcBill(bill);
    try {
      // eslint-disable-next-line no-await-in-loop
      await bill.save();
      return bill;
    } catch (err) {
      if (err.name !== 'VersionError') throw err;
    }
  }
  throw new AppError('This bill is being updated elsewhere. Please try again.', 409);
}

async function createBill(companyId, patient, { visitId = null, userId, settings } = {}) {
  const s = settings || await getSettings(companyId);
  const bill = new HospitalBill({
    companyId,
    billNumber: await nextNumber(companyId, 'bill'),
    patientId: patient._id,
    visitId,
    hmo: hmoFor(patient, s) || undefined,
    createdBy: userId,
  });
  recalcBill(bill);
  return bill.save();
}

// The one bill a visit's charges collect on — created on first use.
async function billForVisit(companyId, visit, patient, userId) {
  if (visit.billId) return visit.billId;
  const bill = await createBill(companyId, patient, { visitId: visit._id, userId });
  const claimed = await HospitalVisit.updateOne({ _id: visit._id, companyId, billId: null }, { $set: { billId: bill._id } });
  if (!claimed.modifiedCount) {
    // A parallel request got there first — use its bill.
    await bill.deleteOne();
    const fresh = await HospitalVisit.findById(visit._id).select('billId').lean();
    visit.billId = fresh.billId;
    return fresh.billId;
  }
  visit.billId = bill._id;
  return bill._id;
}

const cleanCharge = (c, userId) => ({
  category: c.category || 'other',
  description: String(c.description || '').trim().slice(0, 200) || 'Charge',
  quantity: Math.max(0, Number(c.quantity ?? 1) || 0),
  unitPrice: Math.max(0, round2(c.unitPrice)),
  refType: c.refType || null,
  refId: c.refId,
  addedBy: userId,
});

async function addCharges(companyId, billId, charges, userId) {
  if (!charges.length) return null;
  return mutateBill(companyId, billId, (bill) => {
    if (bill.status === 'cancelled') throw new AppError('This bill was cancelled.', 400);
    charges.forEach((c) => bill.items.push(cleanCharge(c, userId)));
  });
}

async function removeCharges(companyId, billId, refType, refId) {
  if (!billId) return null;
  return mutateBill(companyId, billId, (bill) => {
    bill.items = bill.items.filter((it) => !(it.refType === refType && String(it.refId) === String(refId)));
  });
}

// For "pay before service" rules: has the patient settled this bill?
async function assertBillPaid(companyId, billId, what) {
  if (!billId) return;
  const bill = await HospitalBill.findOne({ _id: billId, companyId }).select('balance status billNumber').lean();
  if (bill && bill.status !== 'cancelled' && bill.balance > 0.004) {
    throw new AppError(`Payment needed first: ${bill.billNumber} still has ₦${bill.balance.toLocaleString('en-NG')} to pay before ${what}.`, 400, 'PAYMENT_REQUIRED');
  }
}

// Lab results: H/L against the numeric reference range.
function flagFor(value, low, high) {
  const v = parseFloat(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(v)) return '';
  if (Number.isFinite(low) && v < low) return 'L';
  if (Number.isFinite(high) && v > high) return 'H';
  return '';
}

module.exports = {
  round2, oid, escapeRe, todayStr, getSettings, reserve, nextNumber, nextQueueNumber, emitHospital,
  hmoFor, recalcBill, mutateBill, createBill, billForVisit, addCharges, removeCharges, assertBillPaid,
  flagFor,
};
