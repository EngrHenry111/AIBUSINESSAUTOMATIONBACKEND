'use strict';

// Pharmacy: drug stock in batches (received, adjusted, written off, and
// dispensed first-expiry-first-out), prescriptions from doctors and counter
// sales. A prescription is priced against stock (charges go on the
// patient's bill), then dispensed (stock goes down).

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const PharmacyItem = require('../models/PharmacyItem');
const PharmacyStockMove = require('../models/PharmacyStockMove');
const Prescription = require('../models/Prescription');
const HospitalVisit = require('../models/HospitalVisit');
const Admission = require('../models/Admission');
const HospitalBill = require('../models/HospitalBill');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const {
  round2, escapeRe, getSettings, nextNumber, emitHospital, createBill, addCharges, removeCharges, assertBillPaid,
} = require('../utils/hospital');
const { findOwned } = require('./hospitalController');
const { billIdFor } = require('./hospitalClinicalController');

const io = (req) => req.app.get('io');
const ITEM_FIELDS = ['name', 'genericName', 'form', 'strength', 'unit', 'reorderLevel', 'active'];
const RX_ITEM_FIELDS = ['drugName', 'dose', 'frequency', 'route', 'duration', 'quantity', 'instructions'];

// ── Stock ────────────────────────────────────────────────────────────────
// Takes `qty` out of an item's batches, earliest expiry first (expired
// batches are skipped — they must be written off, never handed out).
// Retries if another dispense changed the item at the same moment.
async function takeStock(companyId, itemId, qty, meta) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const item = await PharmacyItem.findOne({ _id: itemId, companyId });
    if (!item) throw new AppError('Drug not found in stock.', 400);
    const now = new Date();
    const usable = item.batches
      .filter((b) => b.quantity > 0 && (!b.expiresAt || b.expiresAt > now))
      .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
    const available = usable.reduce((s, b) => s + b.quantity, 0);
    if (available < qty) throw new AppError(`Only ${available} ${item.unit} of ${item.name} in date and in stock.`, 400);
    let left = qty;
    const used = [];
    for (const b of usable) {
      if (!left) break;
      const take = Math.min(b.quantity, left);
      b.quantity -= take;
      left -= take;
      used.push({ batchNo: b.batchNo, quantity: take });
    }
    item.batches = item.batches.filter((b) => b.quantity > 0);
    item.stock = item.batches.reduce((s, b) => s + b.quantity, 0);
    try {
      // eslint-disable-next-line no-await-in-loop
      await item.save();
      // eslint-disable-next-line no-await-in-loop
      await PharmacyStockMove.insertMany(used.map((u) => ({
        companyId, itemId, type: meta.type || 'dispensed', quantity: -u.quantity, balanceAfter: item.stock, batchNo: u.batchNo, ...meta,
      })));
      return { item, used };
    } catch (err) {
      if (err.name !== 'VersionError') throw err;
    }
  }
  throw new AppError('Stock is being updated elsewhere. Please try again.', 409);
}

// Puts dispensed stock back (a failed multi-drug dispense, or a return).
async function returnStock(companyId, itemId, used, meta) {
  const item = await PharmacyItem.findOne({ _id: itemId, companyId });
  if (!item) return;
  for (const u of used) {
    const b = item.batches.find((x) => x.batchNo === u.batchNo);
    if (b) b.quantity += u.quantity; else item.batches.push({ batchNo: u.batchNo, quantity: u.quantity });
  }
  item.stock = item.batches.reduce((s, b) => s + b.quantity, 0);
  await item.save();
  await PharmacyStockMove.insertMany(used.map((u) => ({ companyId, itemId, type: 'returned', quantity: u.quantity, balanceAfter: item.stock, batchNo: u.batchNo, ...meta })));
}

exports.getItems = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.active !== 'all') filter.active = true;
    if (req.query.filter === 'low') filter.$expr = { $lte: ['$stock', '$reorderLevel'] };
    if (req.query.filter === 'out') filter.stock = { $lte: 0 };
    if (req.query.filter === 'expiring') filter.batches = { $elemMatch: { quantity: { $gt: 0 }, expiresAt: { $lte: new Date(Date.now() + 60 * 86400000) } } };
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      filter.$or = [{ name: re }, { genericName: re }];
    }
    const items = await PharmacyItem.find(filter).sort({ name: 1 }).limit(Math.min(1000, parseInt(req.query.limit, 10) || 500)).lean();
    const now = Date.now();
    res.status(200).json({
      success: true,
      data: items.map((it) => {
        const live = it.batches.filter((b) => b.quantity > 0);
        const nextExpiry = live.map((b) => b.expiresAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
        return {
          ...it,
          nextExpiry,
          expiredQty: live.filter((b) => b.expiresAt && new Date(b.expiresAt).getTime() <= now).reduce((s, b) => s + b.quantity, 0),
          low: it.stock <= it.reorderLevel,
          value: round2(it.stock * (it.costPrice || 0)),
        };
      }),
    });
  } catch (err) { next(err); }
};

function cleanItem(body) {
  const data = pick(body, ITEM_FIELDS);
  if (body.sellingPrice !== undefined) data.sellingPrice = Math.max(0, round2(body.sellingPrice));
  if (body.costPrice !== undefined) data.costPrice = Math.max(0, round2(body.costPrice));
  if (data.reorderLevel !== undefined) data.reorderLevel = Math.max(0, parseInt(data.reorderLevel, 10) || 0);
  return data;
}

exports.createItem = async (req, res, next) => {
  try {
    const data = cleanItem(req.body);
    if (!data.name) return next(new AppError('Drug name is required.', 400));
    const item = await PharmacyItem.create({ ...data, companyId: req.companyId, stock: 0, batches: [] });
    const qty = Math.max(0, parseInt(req.body.openingStock, 10) || 0);
    if (qty) await receive(req, item._id, { quantity: qty, batchNo: req.body.batchNo, expiresAt: req.body.expiresAt, unitCost: data.costPrice, note: 'Opening stock' });
    emitHospital(io(req), req.companyId, 'pharmacy');
    res.status(201).json({ success: true, data: await PharmacyItem.findById(item._id) });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('That drug (name, strength and form) is already in stock.', 400));
    next(err);
  }
};

exports.updateItem = async (req, res, next) => {
  try {
    const item = await findOwned(PharmacyItem, req, req.params.id, 'Drug');
    Object.assign(item, cleanItem(req.body));
    await item.save();
    emitHospital(io(req), req.companyId, 'pharmacy');
    res.status(200).json({ success: true, data: item });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('That drug (name, strength and form) is already in stock.', 400));
    next(err);
  }
};

async function receive(req, itemId, body) {
  const qty = parseInt(body.quantity, 10);
  if (!(qty > 0)) throw new AppError('Enter the quantity received.', 400);
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new AppError('Invalid expiry date.', 400);
  const batchNo = String(body.batchNo || '').trim().slice(0, 60) || `B${Date.now().toString(36).toUpperCase()}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const item = await PharmacyItem.findOne({ _id: itemId, companyId: req.companyId });
    if (!item) throw new AppError('Drug not found.', 404);
    const same = item.batches.find((b) => b.batchNo === batchNo && String(b.expiresAt || '') === String(expiresAt || ''));
    if (same) same.quantity += qty; else item.batches.push({ batchNo, expiresAt, quantity: qty });
    item.stock = item.batches.reduce((s, b) => s + b.quantity, 0);
    if (body.unitCost !== undefined && Number(body.unitCost) > 0) item.costPrice = round2(body.unitCost);
    try {
      // eslint-disable-next-line no-await-in-loop
      await item.save();
      // eslint-disable-next-line no-await-in-loop
      await PharmacyStockMove.create({
        companyId: req.companyId, itemId, type: 'received', quantity: qty, balanceAfter: item.stock, batchNo,
        supplier: String(body.supplier || '').slice(0, 160), unitCost: Number(body.unitCost) || undefined, note: String(body.note || '').slice(0, 300), by: req.user._id,
      });
      return item;
    } catch (err) {
      if (err.name !== 'VersionError') throw err;
    }
  }
  throw new AppError('Stock is being updated elsewhere. Please try again.', 409);
}

// POST /hospital/pharmacy/items/:id/receive { quantity, batchNo, expiresAt, unitCost, supplier }
exports.receiveStock = async (req, res, next) => {
  try {
    const item = await receive(req, req.params.id, req.body);
    emitHospital(io(req), req.companyId, 'pharmacy');
    res.status(200).json({ success: true, data: item });
  } catch (err) { next(err); }
};

// POST /hospital/pharmacy/items/:id/adjust { batchId, quantity (signed), type: adjusted|expired|damaged, note }
exports.adjustStock = async (req, res, next) => {
  try {
    const type = ['adjusted', 'expired', 'damaged'].includes(req.body.type) ? req.body.type : 'adjusted';
    const delta = parseInt(req.body.quantity, 10);
    if (!delta) return next(new AppError('Enter how many to add or remove.', 400));
    if (type !== 'adjusted' && delta > 0) return next(new AppError('Write-offs remove stock: use a negative number.', 400));
    const item = await findOwned(PharmacyItem, req, req.params.id, 'Drug');
    const batch = req.body.batchId ? item.batches.id(req.body.batchId) : item.batches[0];
    if (!batch && delta < 0) return next(new AppError('Choose the batch to take stock from.', 400));
    if (batch && batch.quantity + delta < 0) return next(new AppError(`That batch only has ${batch.quantity}.`, 400));
    if (batch) batch.quantity += delta; else item.batches.push({ batchNo: 'ADJ', quantity: delta });
    item.batches = item.batches.filter((b) => b.quantity > 0);
    item.stock = item.batches.reduce((s, b) => s + b.quantity, 0);
    await item.save();
    await PharmacyStockMove.create({
      companyId: req.companyId, itemId: item._id, type, quantity: delta, balanceAfter: item.stock, batchNo: batch?.batchNo,
      note: String(req.body.note || '').slice(0, 300), by: req.user._id,
    });
    emitHospital(io(req), req.companyId, 'pharmacy');
    res.status(200).json({ success: true, data: item });
  } catch (err) {
    if (err.name === 'VersionError') return next(new AppError('Stock changed while you were editing. Please try again.', 409));
    next(err);
  }
};

exports.getMoves = async (req, res, next) => {
  try {
    const item = await findOwned(PharmacyItem, req, req.params.id, 'Drug');
    const moves = await PharmacyStockMove.find({ companyId: req.companyId, itemId: item._id }).sort({ createdAt: -1 }).limit(300).populate('by', 'name').lean();
    res.status(200).json({ success: true, data: { item, moves } });
  } catch (err) { next(err); }
};

// ── Prescriptions ────────────────────────────────────────────────────────
exports.getPrescriptions = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.status === 'pending') filter.status = { $in: ['pending', 'billed'] };
    else if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (mongoose.isValidObjectId(req.query.patientId)) filter.patientId = req.query.patientId;
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      const pts = await Patient.find({ companyId: req.companyId, $or: [{ firstName: re }, { lastName: re }, { hospitalNumber: re }] }).limit(300).distinct('_id');
      filter.$or = [{ rxNumber: re }, { patientId: { $in: pts } }];
    }
    const rows = await Prescription.find(filter).sort(filter.status?.$in ? { createdAt: 1 } : { createdAt: -1 }).limit(300)
      .populate('patientId', 'firstName lastName hospitalNumber allergies').populate('prescribedBy', 'name').lean();
    const bills = await HospitalBill.find({ _id: { $in: rows.map((r) => r.billId).filter(Boolean) } }).select('balance status').lean();
    const billMap = new Map(bills.map((b) => [String(b._id), b]));
    const counts = await Prescription.aggregate([{ $match: { companyId: new mongoose.Types.ObjectId(String(req.companyId)) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    res.status(200).json({ success: true, data: rows.map((r) => ({ ...r, bill: r.billId ? billMap.get(String(r.billId)) || null : null })), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
  } catch (err) { next(err); }
};

exports.getPrescription = async (req, res, next) => {
  try {
    const rx = await findOwned(Prescription, req, req.params.id, 'Prescription');
    await rx.populate([{ path: 'patientId' }, { path: 'prescribedBy', select: 'name' }, { path: 'billedBy', select: 'name' }, { path: 'dispensedBy', select: 'name' }]);
    const [settings, bill, matches] = await Promise.all([
      getSettings(req.companyId),
      rx.billId ? HospitalBill.findById(rx.billId).select('billNumber balance status hmo').lean() : null,
      // Suggested stock for each line, by name.
      Promise.all(rx.items.map((it) => PharmacyItem.find({
        companyId: req.companyId, active: true,
        $or: [{ name: new RegExp(escapeRe(it.drugName.split(/\s+/)[0]), 'i') }, { genericName: new RegExp(escapeRe(it.drugName.split(/\s+/)[0]), 'i') }],
      }).limit(8).select('name genericName strength form unit sellingPrice stock').lean())),
    ]);
    res.status(200).json({
      success: true,
      data: {
        prescription: rx, bill, payBeforePharmacy: settings.payBeforePharmacy,
        suggestions: Object.fromEntries(rx.items.map((it, i) => [String(it._id), matches[i]])),
        hospital: pick(settings.toObject(), ['hospitalName', 'address', 'phone', 'email', 'logo']),
      },
    });
  } catch (err) { next(err); }
};

function cleanRxItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && String(it.drugName || '').trim()).slice(0, 40)
    .map((it) => ({
      ...pick(it, RX_ITEM_FIELDS),
      drugName: String(it.drugName).trim().slice(0, 200),
      quantity: Math.max(0, parseInt(it.quantity, 10) || 0),
      ...(mongoose.isValidObjectId(it.itemId) && { itemId: it.itemId }),
    }));
}

// POST /hospital/pharmacy/prescriptions { visitId | admissionId | patientId, items, notes }
exports.createPrescription = async (req, res, next) => {
  try {
    const { visitId, admissionId } = req.body;
    let patientId = req.body.patientId;
    if (admissionId) patientId = (await findOwned(Admission, req, admissionId, 'Admission')).patientId;
    else if (visitId) patientId = (await findOwned(HospitalVisit, req, visitId, 'Visit')).patientId;
    const patient = mongoose.isValidObjectId(patientId) && await Patient.findOne({ _id: patientId, companyId: req.companyId });
    if (!patient) return next(new AppError('Choose a patient.', 400));
    const items = cleanRxItems(req.body.items);
    if (!items.length) return next(new AppError('Add at least one drug.', 400));
    const counter = !visitId && !admissionId;
    const rx = await Prescription.create({
      companyId: req.companyId,
      rxNumber: await nextNumber(req.companyId, 'rx'),
      patientId: patient._id,
      visitId: visitId || undefined,
      admissionId: admissionId || undefined,
      billId: counter ? undefined : await billIdFor(req, { visitId, admissionId }),
      items,
      notes: String(req.body.notes || '').slice(0, 1000),
      source: counter ? 'counter' : 'doctor',
      prescribedBy: req.user._id,
    });
    emitHospital(io(req), req.companyId, 'pharmacy', { prescriptionId: rx._id, message: `New prescription ${rx.rxNumber}` });
    res.status(201).json({ success: true, data: rx });
  } catch (err) { next(err); }
};

// PUT /hospital/pharmacy/prescriptions/:id — the doctor edits before it's priced.
exports.updatePrescription = async (req, res, next) => {
  try {
    const rx = await findOwned(Prescription, req, req.params.id, 'Prescription');
    if (rx.status !== 'pending') return next(new AppError('The pharmacy has already priced this prescription.', 400));
    if (req.body.items !== undefined) {
      const items = cleanRxItems(req.body.items);
      if (!items.length) return next(new AppError('Add at least one drug.', 400));
      rx.items = items;
    }
    if (req.body.notes !== undefined) rx.notes = String(req.body.notes || '').slice(0, 1000);
    await rx.save();
    emitHospital(io(req), req.companyId, 'pharmacy', { prescriptionId: rx._id });
    res.status(200).json({ success: true, data: rx });
  } catch (err) { next(err); }
};

// POST /hospital/pharmacy/prescriptions/:id/bill { items: [{ _id, itemId, quantity, notAvailable }] }
// Matches each line to stock, prices it and puts it on the bill. Can be
// redone until dispensed (the old charges are replaced).
exports.billPrescription = async (req, res, next) => {
  try {
    const rx = await findOwned(Prescription, req, req.params.id, 'Prescription');
    if (!['pending', 'billed'].includes(rx.status)) return next(new AppError(`This prescription is ${rx.status}.`, 400));
    const lines = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((l) => [String(l._id), l]));
    const stockIds = [...lines.values()].map((l) => l.itemId).filter((id) => mongoose.isValidObjectId(id));
    const stock = new Map((await PharmacyItem.find({ _id: { $in: stockIds }, companyId: req.companyId }).lean()).map((s) => [String(s._id), s]));

    for (const it of rx.items) {
      const l = lines.get(String(it._id)) || {};
      if (l.notAvailable) { Object.assign(it, { status: 'not_available', unitPrice: 0, amount: 0 }); continue; }
      const s = stock.get(String(l.itemId || it.itemId));
      if (!s) throw new AppError(`Choose the stock item for ${it.drugName}, or mark it not available.`, 400);
      const qty = Math.max(0, parseInt(l.quantity ?? it.quantity, 10) || 0);
      if (!qty) throw new AppError(`Enter the quantity for ${it.drugName}.`, 400);
      if (s.stock < qty) throw new AppError(`Only ${s.stock} ${s.unit} of ${s.name} in stock. Reduce the quantity or mark it not available.`, 400);
      Object.assign(it, { itemId: s._id, quantity: qty, unitPrice: s.sellingPrice, amount: round2(qty * s.sellingPrice), status: 'billed' });
    }
    if (!rx.items.some((it) => it.status === 'billed')) throw new AppError('Nothing to supply: every drug is marked not available.', 400);

    if (!rx.billId) {
      const patient = await Patient.findById(rx.patientId);
      rx.billId = (await createBill(req.companyId, patient, { userId: req.user._id }))._id;
    }
    await removeCharges(req.companyId, rx.billId, 'prescription', rx._id);
    await addCharges(req.companyId, rx.billId, rx.items.filter((it) => it.status === 'billed').map((it) => {
      const s = stock.get(String(it.itemId));
      return { category: 'pharmacy', description: `${s.name}${s.strength ? ` ${s.strength}` : ''} × ${it.quantity} ${s.unit}`, quantity: it.quantity, unitPrice: it.unitPrice, refType: 'prescription', refId: rx._id };
    }), req.user._id);
    rx.status = 'billed';
    rx.billedBy = req.user._id;
    rx.billedAt = new Date();
    await rx.save();
    emitHospital(io(req), req.companyId, 'pharmacy', { prescriptionId: rx._id });
    emitHospital(io(req), req.companyId, 'bills', { billId: rx.billId });
    res.status(200).json({ success: true, data: rx });
  } catch (err) { next(err); }
};

// POST /hospital/pharmacy/prescriptions/:id/dispense — hand over the drugs.
exports.dispense = async (req, res, next) => {
  try {
    const rx = await findOwned(Prescription, req, req.params.id, 'Prescription');
    if (rx.status !== 'billed') return next(new AppError(rx.status === 'dispensed' ? 'Already dispensed.' : 'Price the prescription first.', 400));
    const settings = await getSettings(req.companyId);
    if (settings.payBeforePharmacy && !rx.admissionId) await assertBillPaid(req.companyId, rx.billId, 'drugs are dispensed');
    // Claim it so a double-click can't dispense twice.
    const claimed = await Prescription.updateOne({ _id: rx._id, companyId: req.companyId, status: 'billed' }, { $set: { status: 'dispensed' } });
    if (!claimed.modifiedCount) return next(new AppError('Already dispensed.', 400));

    const done = [];
    try {
      for (const it of rx.items.filter((x) => x.status === 'billed')) {
        // eslint-disable-next-line no-await-in-loop
        const { used } = await takeStock(req.companyId, it.itemId, it.quantity, { prescriptionId: rx._id, by: req.user._id });
        done.push({ itemId: it.itemId, used });
        it.status = 'dispensed';
      }
    } catch (err) {
      for (const d of done) {
        // eslint-disable-next-line no-await-in-loop
        await returnStock(req.companyId, d.itemId, d.used, { prescriptionId: rx._id, by: req.user._id, note: 'Dispense undone' });
      }
      await Prescription.updateOne({ _id: rx._id }, { $set: { status: 'billed' } });
      throw err;
    }
    rx.status = 'dispensed';
    rx.dispensedBy = req.user._id;
    rx.dispensedAt = new Date();
    await rx.save();
    emitHospital(io(req), req.companyId, 'pharmacy', { prescriptionId: rx._id });
    res.status(200).json({ success: true, data: rx });
  } catch (err) { next(err); }
};

exports.cancelPrescription = async (req, res, next) => {
  try {
    const rx = await findOwned(Prescription, req, req.params.id, 'Prescription');
    if (rx.status === 'dispensed') return next(new AppError('Dispensed drugs cannot be cancelled. Return them to stock instead.', 400));
    if (rx.status === 'cancelled') return next(new AppError('Already cancelled.', 400));
    rx.status = 'cancelled';
    await rx.save();
    const bill = rx.billId ? await removeCharges(req.companyId, rx.billId, 'prescription', rx._id) : null;
    emitHospital(io(req), req.companyId, 'pharmacy', { prescriptionId: rx._id });
    emitHospital(io(req), req.companyId, 'bills', { billId: rx.billId });
    res.status(200).json({ success: true, data: { prescription: rx, refundDue: bill && bill.balance < 0 ? -bill.balance : 0 } });
  } catch (err) { next(err); }
};

exports._internal = { takeStock, returnStock };
