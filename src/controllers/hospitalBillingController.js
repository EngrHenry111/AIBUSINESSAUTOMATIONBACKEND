'use strict';

// The cashier's side: bills, payments and receipts, debtors, HMO claims —
// and the owner's reports.

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const HospitalBill = require('../models/HospitalBill');
const HospitalPayment = require('../models/HospitalPayment');
const HospitalVisit = require('../models/HospitalVisit');
const LabRequest = require('../models/LabRequest');
const PharmacyStockMove = require('../models/PharmacyStockMove');
const Admission = require('../models/Admission');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const {
  round2, oid, escapeRe, getSettings, nextNumber, emitHospital, mutateBill, addCharges,
} = require('../utils/hospital');
const { findOwned } = require('./hospitalController');

const io = (req) => req.app.get('io');
const METHODS = ['cash', 'pos', 'bank_transfer', 'cheque', 'online'];

// ?from=YYYY-MM-DD&to=YYYY-MM-DD → Date range (default: this month).
function range(q) {
  const now = new Date();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? new Date(`${q.from}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? new Date(`${q.to}T23:59:59.999`) : now;
  return { from, to };
}

async function patientIdsMatching(companyId, search) {
  const re = new RegExp(escapeRe(String(search).trim()), 'i');
  return Patient.find({ companyId, $or: [{ firstName: re }, { lastName: re }, { hospitalNumber: re }, { phone: re }] }).limit(500).distinct('_id');
}

// ── Bills ────────────────────────────────────────────────────────────────
exports.getBills = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.status === 'owing') filter.status = { $in: ['unpaid', 'partial'] };
    else if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    else filter.status = { $ne: 'cancelled' };
    if (mongoose.isValidObjectId(req.query.patientId)) filter.patientId = req.query.patientId;
    if (req.query.hmo) filter['hmo.name'] = req.query.hmo;
    if (req.query.from || req.query.to) { const { from, to } = range(req.query); filter.createdAt = { $gte: from, $lte: to }; }
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      filter.$or = [{ billNumber: re }, { patientId: { $in: await patientIdsMatching(req.companyId, req.query.search) } }];
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const [bills, total, sums] = await Promise.all([
      HospitalBill.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit)
        .select('-items.addedBy').populate('patientId', 'firstName lastName hospitalNumber phone').lean(),
      HospitalBill.countDocuments(filter),
      HospitalBill.aggregate([{ $match: { ...filter, companyId: oid(req.companyId) } }, { $group: { _id: null, total: { $sum: '$total' }, paid: { $sum: '$amountPaid' }, balance: { $sum: { $max: ['$balance', 0] } }, hmo: { $sum: '$hmoAmount' } } }]),
    ]);
    res.status(200).json({ success: true, data: bills, totals: sums[0] || { total: 0, paid: 0, balance: 0, hmo: 0 }, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

exports.getBill = async (req, res, next) => {
  try {
    const bill = await findOwned(HospitalBill, req, req.params.id, 'Bill');
    await bill.populate([{ path: 'patientId', select: 'firstName lastName otherNames hospitalNumber phone insurance' }, { path: 'items.addedBy', select: 'name' }]);
    const [payments, visit, settings] = await Promise.all([
      HospitalPayment.find({ companyId: req.companyId, billId: bill._id }).sort({ paidAt: -1 }).populate('recordedBy', 'name').populate('voidedBy', 'name').lean(),
      bill.visitId ? HospitalVisit.findById(bill.visitId).select('visitNumber date department type status').lean() : null,
      getSettings(req.companyId),
    ]);
    res.status(200).json({ success: true, data: { bill, payments, visit, services: settings.services.filter((s) => s.active !== false), hospital: pick(settings.toObject(), ['hospitalName', 'address', 'phone', 'email', 'logo']) } });
  } catch (err) { next(err); }
};

// POST /hospital/billing/bills/:id/items { serviceId, quantity } | { description, unitPrice, quantity, category }
exports.addItem = async (req, res, next) => {
  try {
    const bill = await findOwned(HospitalBill, req, req.params.id, 'Bill');
    const settings = await getSettings(req.companyId);
    let charge;
    if (req.body.serviceId) {
      const s = settings.services.id(req.body.serviceId);
      if (!s) return next(new AppError('Service not found.', 400));
      charge = { category: s.category, description: s.name, unitPrice: s.price, quantity: req.body.quantity ?? 1, refType: 'service', refId: s._id };
    } else {
      if (!String(req.body.description || '').trim()) return next(new AppError('Describe the charge.', 400));
      charge = { category: ['consultation', 'nursing', 'procedure', 'other'].includes(req.body.category) ? req.body.category : 'other', description: req.body.description, unitPrice: req.body.unitPrice, quantity: req.body.quantity ?? 1 };
    }
    const updated = await addCharges(req.companyId, bill._id, [charge], req.user._id);
    emitHospital(io(req), req.companyId, 'bills', { billId: bill._id });
    res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
};

// DELETE /hospital/billing/bills/:id/items/:itemId — lab and drug lines are
// removed by cancelling the request/prescription, so they stay in step.
exports.removeItem = async (req, res, next) => {
  try {
    const updated = await mutateBill(req.companyId, req.params.id, (bill) => {
      const it = bill.items.id(req.params.itemId);
      if (!it) throw new AppError('Line not found.', 404);
      if (['lab', 'prescription'].includes(it.refType)) throw new AppError(`Cancel the ${it.refType === 'lab' ? 'lab request' : 'prescription'} to remove this line.`, 400);
      it.deleteOne();
    });
    emitHospital(io(req), req.companyId, 'bills', { billId: updated._id });
    res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
};

// PUT /hospital/billing/bills/:id/discount { discount, reason } — managers.
exports.setDiscount = async (req, res, next) => {
  try {
    const discount = Math.max(0, round2(req.body.discount));
    const updated = await mutateBill(req.companyId, req.params.id, (bill) => {
      if (bill.status === 'cancelled') throw new AppError('This bill was cancelled.', 400);
      if (discount > bill.subtotal) throw new AppError('The discount is more than the bill.', 400);
      bill.discount = discount;
      bill.discountReason = String(req.body.reason || '').slice(0, 200);
    });
    emitHospital(io(req), req.companyId, 'bills', { billId: updated._id });
    res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
};

// PUT /hospital/billing/bills/:id/hmo { name | null } — attach or remove HMO cover.
exports.setBillHmo = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const hmo = req.body.name ? settings.hmos.find((h) => h.name === req.body.name) : null;
    if (req.body.name && !hmo) return next(new AppError('HMO not found. Add it in Settings first.', 400));
    const updated = await mutateBill(req.companyId, req.params.id, (bill) => {
      if (bill.claim?.status && ['submitted', 'paid'].includes(bill.claim.status)) throw new AppError('The HMO claim for this bill is already submitted.', 400);
      bill.hmo = hmo ? { name: hmo.name, enrolleeId: String(req.body.enrolleeId || bill.hmo?.enrolleeId || ''), coverPercent: hmo.coverPercent } : undefined;
    });
    emitHospital(io(req), req.companyId, 'bills', { billId: updated._id });
    res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
};

exports.cancelBill = async (req, res, next) => {
  try {
    const bill = await findOwned(HospitalBill, req, req.params.id, 'Bill');
    if (await HospitalPayment.exists({ companyId: req.companyId, billId: bill._id, voided: false })) return next(new AppError('Void the payments on this bill first.', 400));
    bill.status = 'cancelled';
    await bill.save();
    emitHospital(io(req), req.companyId, 'bills', { billId: bill._id });
    res.status(200).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

// ── Payments ─────────────────────────────────────────────────────────────
// POST /hospital/billing/payments { billId, amount, method, reference, note }
exports.recordPayment = async (req, res, next) => {
  try {
    const amount = round2(req.body.amount);
    if (!(amount > 0)) return next(new AppError('Enter the amount received.', 400));
    const method = METHODS.includes(req.body.method) ? req.body.method : 'cash';
    if (!mongoose.isValidObjectId(req.body.billId)) return next(new AppError('Choose the bill.', 400));
    const bill = await mutateBill(req.companyId, req.body.billId, (b) => {
      if (b.status === 'cancelled') throw new AppError('This bill was cancelled.', 400);
      if (amount > b.balance + 0.004) throw new AppError(`That is more than the ₦${Math.max(0, b.balance).toLocaleString('en-NG')} owed.`, 400);
      b.amountPaid = round2(b.amountPaid + amount);
    });
    let payment;
    try {
      payment = await HospitalPayment.create({
        companyId: req.companyId, receiptNumber: await nextNumber(req.companyId, 'receipt'),
        billId: bill._id, patientId: bill.patientId, amount, method,
        reference: String(req.body.reference || '').slice(0, 100), note: String(req.body.note || '').slice(0, 300),
        recordedBy: req.user._id,
      });
    } catch (err) {
      await mutateBill(req.companyId, bill._id, (b) => { b.amountPaid = round2(b.amountPaid - amount); });
      throw err;
    }
    emitHospital(io(req), req.companyId, 'payment', { paymentId: payment._id, billId: bill._id, message: `₦${amount.toLocaleString('en-NG')} received (${payment.receiptNumber})` });
    res.status(201).json({ success: true, data: { payment, bill } });
  } catch (err) { next(err); }
};

exports.getPayments = async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const filter = { companyId: req.companyId, paidAt: { $gte: from, $lte: to } };
    if (req.query.voided !== 'all') filter.voided = false;
    if (METHODS.includes(req.query.method)) filter.method = req.query.method;
    if (mongoose.isValidObjectId(req.query.recordedBy)) filter.recordedBy = req.query.recordedBy;
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      filter.$or = [{ receiptNumber: re }, { reference: re }, { patientId: { $in: await patientIdsMatching(req.companyId, req.query.search) } }];
    }
    const [payments, byMethod] = await Promise.all([
      HospitalPayment.find(filter).sort({ paidAt: -1 }).limit(1000).populate('patientId', 'firstName lastName hospitalNumber').populate('recordedBy', 'name').populate('billId', 'billNumber').lean(),
      HospitalPayment.aggregate([{ $match: { ...filter, companyId: oid(req.companyId), voided: false } }, { $group: { _id: '$method', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    ]);
    res.status(200).json({ success: true, data: payments, byMethod: Object.fromEntries(byMethod.map((m) => [m._id, { amount: m.amount, n: m.n }])), total: round2(byMethod.reduce((s, m) => s + m.amount, 0)) });
  } catch (err) { next(err); }
};

// GET /hospital/billing/payments/:id — the receipt.
exports.getPayment = async (req, res, next) => {
  try {
    const payment = await findOwned(HospitalPayment, req, req.params.id, 'Payment');
    await payment.populate([{ path: 'patientId', select: 'firstName lastName otherNames hospitalNumber phone' }, { path: 'recordedBy', select: 'name' }, { path: 'billId' }]);
    const settings = await getSettings(req.companyId);
    res.status(200).json({ success: true, data: { payment, hospital: pick(settings.toObject(), ['hospitalName', 'address', 'phone', 'email', 'logo']) } });
  } catch (err) { next(err); }
};

exports.voidPayment = async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return next(new AppError('Give a reason for voiding.', 400));
    const payment = await HospitalPayment.findOneAndUpdate(
      { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null, companyId: req.companyId, voided: false },
      { $set: { voided: true, voidedAt: new Date(), voidedBy: req.user._id, voidReason: reason.slice(0, 300) } },
      { new: true },
    );
    if (!payment) return next(new AppError('Payment not found or already voided.', 404));
    await mutateBill(req.companyId, payment.billId, (b) => { b.amountPaid = round2(b.amountPaid - payment.amount); });
    emitHospital(io(req), req.companyId, 'payment', { paymentId: payment._id, billId: payment.billId });
    res.status(200).json({ success: true, data: payment });
  } catch (err) { next(err); }
};

// ── Debtors & HMO claims ─────────────────────────────────────────────────
exports.getDebtors = async (req, res, next) => {
  try {
    const rows = await HospitalBill.aggregate([
      { $match: { companyId: oid(req.companyId), status: { $in: ['unpaid', 'partial'] } } },
      { $group: { _id: '$patientId', balance: { $sum: '$balance' }, bills: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
      { $sort: { balance: -1 } }, { $limit: 500 },
      { $lookup: { from: 'patients', localField: '_id', foreignField: '_id', as: 'p' } }, { $unwind: '$p' },
      { $project: { balance: 1, bills: 1, oldest: 1, patient: { _id: '$p._id', firstName: '$p.firstName', lastName: '$p.lastName', hospitalNumber: '$p.hospitalNumber', phone: '$p.phone' } } },
    ]);
    res.status(200).json({ success: true, data: rows, total: round2(rows.reduce((s, r) => s + r.balance, 0)) });
  } catch (err) { next(err); }
};

// GET /hospital/billing/claims?hmo&status&from&to — the HMO's share of bills.
exports.getClaims = async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const filter = { companyId: req.companyId, status: { $ne: 'cancelled' }, hmoAmount: { $gt: 0 }, createdAt: { $gte: from, $lte: to } };
    if (req.query.hmo) filter['hmo.name'] = req.query.hmo;
    if (['pending', 'submitted', 'paid', 'rejected'].includes(req.query.status)) filter['claim.status'] = req.query.status;
    const bills = await HospitalBill.find(filter).sort({ createdAt: 1 }).limit(2000)
      .select('billNumber patientId hmo hmoAmount total claim createdAt items.description items.amount items.category')
      .populate('patientId', 'firstName lastName hospitalNumber insurance').lean();
    const byHmo = {};
    for (const b of bills) {
      const k = b.hmo?.name || '—';
      const row = byHmo[k] || (byHmo[k] = { hmo: k, bills: 0, amount: 0, pending: 0, submitted: 0, paid: 0, rejected: 0 });
      row.bills += 1;
      row.amount = round2(row.amount + b.hmoAmount);
      row[b.claim?.status || 'pending'] = round2(row[b.claim?.status || 'pending'] + b.hmoAmount);
    }
    res.status(200).json({ success: true, data: bills, summary: Object.values(byHmo) });
  } catch (err) { next(err); }
};

// PUT /hospital/billing/claims { billIds, status, reference, note }
exports.updateClaims = async (req, res, next) => {
  try {
    const status = req.body.status;
    if (!['pending', 'submitted', 'paid', 'rejected'].includes(status)) return next(new AppError('Invalid claim status.', 400));
    const ids = (Array.isArray(req.body.billIds) ? req.body.billIds : []).filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) return next(new AppError('Choose the bills.', 400));
    const set = { 'claim.status': status };
    if (status === 'submitted') set['claim.submittedAt'] = new Date();
    if (status === 'paid') set['claim.paidAt'] = new Date();
    if (req.body.reference !== undefined) set['claim.reference'] = String(req.body.reference || '').slice(0, 80);
    if (req.body.note !== undefined) set['claim.note'] = String(req.body.note || '').slice(0, 300);
    const r = await HospitalBill.updateMany({ _id: { $in: ids }, companyId: req.companyId, hmoAmount: { $gt: 0 } }, { $set: set });
    emitHospital(io(req), req.companyId, 'bills');
    res.status(200).json({ success: true, data: { updated: r.modifiedCount } });
  } catch (err) { next(err); }
};

// ── Reports (owners/managers) ────────────────────────────────────────────
exports.getReport = async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const cid = oid(req.companyId);
    const createdIn = { $gte: from, $lte: to };
    const tz = process.env.HOSPITAL_TZ || 'Africa/Lagos';
    const fromStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(from);
    const toStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(to);

    const [billed, collected, visits, byDept, byDoctor, diagnoses, newPatients, labTests, drugs, admissions, discharges, hmo, outstanding] = await Promise.all([
      HospitalBill.aggregate([
        { $match: { companyId: cid, status: { $ne: 'cancelled' } } }, { $unwind: '$items' },
        { $match: { 'items.addedAt': createdIn } },
        { $group: { _id: '$items.category', amount: { $sum: '$items.amount' } } },
      ]),
      HospitalPayment.aggregate([{ $match: { companyId: cid, voided: false, paidAt: createdIn } }, { $group: { _id: '$method', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      HospitalVisit.aggregate([{ $match: { companyId: cid, date: { $gte: fromStr, $lte: toStr }, status: { $ne: 'cancelled' } } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
      HospitalVisit.aggregate([{ $match: { companyId: cid, date: { $gte: fromStr, $lte: toStr }, status: { $ne: 'cancelled' } } }, { $group: { _id: '$department', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      HospitalVisit.aggregate([
        { $match: { companyId: cid, date: { $gte: fromStr, $lte: toStr }, status: { $in: ['completed', 'admitted'] }, doctorId: { $ne: null } } },
        { $group: { _id: '$doctorId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $project: { n: 1, name: { $first: '$u.name' } } },
      ]),
      HospitalVisit.aggregate([
        { $match: { companyId: cid, date: { $gte: fromStr, $lte: toStr } } }, { $unwind: '$consultation.diagnoses' },
        { $group: { _id: { $toLower: '$consultation.diagnoses.text' }, text: { $first: '$consultation.diagnoses.text' }, code: { $first: '$consultation.diagnoses.code' }, n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 15 },
      ]),
      Patient.countDocuments({ companyId: req.companyId, createdAt: createdIn }),
      LabRequest.aggregate([
        { $match: { companyId: cid, createdAt: createdIn, status: { $ne: 'cancelled' } } }, { $unwind: '$tests' },
        { $group: { _id: '$tests.name', n: { $sum: 1 }, amount: { $sum: '$tests.price' } } }, { $sort: { n: -1 } }, { $limit: 15 },
      ]),
      PharmacyStockMove.aggregate([
        { $match: { companyId: cid, type: 'dispensed', createdAt: createdIn } },
        { $group: { _id: '$itemId', qty: { $sum: { $abs: '$quantity' } } } }, { $sort: { qty: -1 } }, { $limit: 15 },
        { $lookup: { from: 'pharmacyitems', localField: '_id', foreignField: '_id', as: 'i' } },
        { $project: { qty: 1, name: { $first: '$i.name' }, strength: { $first: '$i.strength' }, unit: { $first: '$i.unit' } } },
      ]),
      Admission.countDocuments({ companyId: req.companyId, admittedAt: createdIn }),
      Admission.aggregate([{ $match: { companyId: cid, 'discharge.at': createdIn } }, { $group: { _id: '$discharge.outcome', n: { $sum: 1 }, days: { $sum: '$discharge.bedDays' } } }]),
      HospitalBill.aggregate([{ $match: { companyId: cid, status: { $ne: 'cancelled' }, hmoAmount: { $gt: 0 }, createdAt: createdIn } }, { $group: { _id: '$hmo.name', amount: { $sum: '$hmoAmount' }, n: { $sum: 1 } } }, { $sort: { amount: -1 } }]),
      HospitalBill.aggregate([{ $match: { companyId: cid, status: { $in: ['unpaid', 'partial'] } } }, { $group: { _id: null, amount: { $sum: '$balance' } } }]),
    ]);
    const sum = (rows, k = 'amount') => round2(rows.reduce((s, r) => s + (r[k] || 0), 0));
    const discharged = discharges.reduce((s, d) => s + d.n, 0);
    res.status(200).json({
      success: true,
      data: {
        from, to,
        revenue: { billed: sum(billed), byCategory: Object.fromEntries(billed.map((b) => [b._id, round2(b.amount)])), collected: sum(collected), byMethod: Object.fromEntries(collected.map((c) => [c._id, { amount: c.amount, n: c.n }])), outstanding: round2(outstanding[0]?.amount || 0), hmo: hmo.map((h) => ({ hmo: h._id, amount: round2(h.amount), bills: h.n })) },
        patients: { new: newPatients },
        visits: { total: visits.reduce((s, v) => s + v.n, 0), byType: Object.fromEntries(visits.map((v) => [v._id, v.n])), byDepartment: byDept.map((d) => ({ department: d._id || '—', n: d.n })), byDoctor: byDoctor.map((d) => ({ name: d.name || '—', n: d.n })) },
        diagnoses: diagnoses.map((d) => ({ text: d.text, code: d.code, n: d.n })),
        lab: labTests.map((t) => ({ name: t._id, n: t.n, amount: t.amount })),
        drugs: drugs.map((d) => ({ name: [d.name, d.strength].filter(Boolean).join(' '), qty: d.qty, unit: d.unit })),
        admissions: { admitted: admissions, discharged, byOutcome: Object.fromEntries(discharges.map((d) => [d._id || 'other', d.n])), averageStay: discharged ? round2(discharges.reduce((s, d) => s + (d.days || 0), 0) / discharged) : null },
      },
    });
  } catch (err) { next(err); }
};
