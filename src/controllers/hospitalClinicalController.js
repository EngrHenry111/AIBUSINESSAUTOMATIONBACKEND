'use strict';

// Patient flow: check-in → triage (vitals) → consultation → completed or
// admitted; and the wards — beds, admissions, the nursing chart, transfers
// and discharge (which bills the bed days).

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const HospitalVisit = require('../models/HospitalVisit');
const HospitalAppointment = require('../models/HospitalAppointment');
const HospitalBill = require('../models/HospitalBill');
const HospitalPayment = require('../models/HospitalPayment');
const LabRequest = require('../models/LabRequest');
const Prescription = require('../models/Prescription');
const Admission = require('../models/Admission');
const Ward = require('../models/Ward');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const { seesClinical } = require('../utils/hospitalAccess');
const {
  round2, oid, todayStr, getSettings, nextNumber, nextQueueNumber, emitHospital,
  billForVisit, addCharges,
} = require('../utils/hospital');
const { findOwned } = require('./hospitalController');

const io = (req) => req.app.get('io');
const ACTIVE = ['waiting', 'triaged', 'in_consultation'];
const VITAL_FIELDS = ['systolic', 'diastolic', 'temperature', 'pulse', 'respiration', 'spo2', 'weight', 'height', 'glucose', 'painScore'];
const CONSULT_FIELDS = ['complaint', 'history', 'examination', 'assessment', 'diagnoses', 'plan', 'followUpDate'];
const DAY = 86400000;

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));

function cleanVitals(body) {
  const v = {};
  VITAL_FIELDS.forEach((k) => { const n = num(body[k]); if (n !== undefined) v[k] = n; });
  if (v.weight && v.height) v.bmi = round2(v.weight / ((v.height / 100) ** 2));
  return v;
}

const stamp = (visit, status, userId) => visit.timeline.push({ status, by: userId, at: new Date() });

async function assertDoctor(companyId, doctorId) {
  if (!doctorId) return null;
  if (!mongoose.isValidObjectId(doctorId) || !(await User.exists({ _id: doctorId, companyId }))) throw new AppError('Doctor not found.', 400);
  return doctorId;
}

// ── Queue / visits ───────────────────────────────────────────────────────
// GET /hospital/visits?date&status&doctorId&department&mine
exports.getVisits = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.patientId && mongoose.isValidObjectId(req.query.patientId)) filter.patientId = req.query.patientId;
    else filter.date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
    if (req.query.status === 'active') filter.status = { $in: ACTIVE };
    else if (req.query.status) filter.status = req.query.status;
    if (req.query.mine === '1') filter.doctorId = req.user._id;
    else if (mongoose.isValidObjectId(req.query.doctorId)) filter.doctorId = req.query.doctorId;
    if (req.query.department) filter.department = req.query.department;

    const visits = await HospitalVisit.find(filter).sort({ queueNumber: 1, createdAt: 1 }).limit(500)
      .select('-consultation.history -consultation.examination -timeline')
      .populate('patientId', 'firstName lastName otherNames hospitalNumber gender dateOfBirth allergies insurance.hmo')
      .populate('doctorId', 'name').lean();
    const ids = visits.map((v) => v._id);
    const [labs, rxs, bills] = await Promise.all([
      LabRequest.aggregate([{ $match: { companyId: oid(req.companyId), visitId: { $in: ids } } }, { $group: { _id: { v: '$visitId', s: '$status' }, n: { $sum: 1 } } }]),
      Prescription.aggregate([{ $match: { companyId: oid(req.companyId), visitId: { $in: ids } } }, { $group: { _id: { v: '$visitId', s: '$status' }, n: { $sum: 1 } } }]),
      HospitalBill.find({ companyId: req.companyId, _id: { $in: visits.map((v) => v.billId).filter(Boolean) } }).select('balance status').lean(),
    ]);
    const count = (rows) => {
      const m = new Map();
      rows.forEach((r) => { const k = String(r._id.v); m.set(k, { ...(m.get(k) || {}), [r._id.s]: r.n }); });
      return m;
    };
    const labMap = count(labs);
    const rxMap = count(rxs);
    const billMap = new Map(bills.map((b) => [String(b._id), b]));
    const clinical = seesClinical(req);
    res.status(200).json({
      success: true,
      data: visits.map((v) => {
        const out = {
          ...v,
          lab: labMap.get(String(v._id)) || {},
          rx: rxMap.get(String(v._id)) || {},
          bill: v.billId ? billMap.get(String(v.billId)) || null : null,
          latestVitals: clinical ? v.vitals?.[v.vitals.length - 1] || null : null,
        };
        delete out.vitals;
        if (!clinical) delete out.consultation;
        return out;
      }),
    });
  } catch (err) { next(err); }
};

// POST /hospital/visits — check a patient in.
exports.checkIn = async (req, res, next) => {
  try {
    const { patientId, appointmentId } = req.body;
    if (!mongoose.isValidObjectId(patientId)) return next(new AppError('Choose a patient.', 400));
    const patient = await Patient.findOne({ _id: patientId, companyId: req.companyId });
    if (!patient) return next(new AppError('Patient not found.', 404));
    if (patient.status === 'deceased') return next(new AppError('This patient is recorded as deceased.', 400));
    const today = todayStr();
    const open = await HospitalVisit.findOne({ companyId: req.companyId, patientId, date: today, status: { $in: ACTIVE } }).select('visitNumber queueNumber').lean();
    if (open) return next(new AppError(`Already checked in today (queue no. ${open.queueNumber}, ${open.visitNumber}).`, 409, 'ALREADY_CHECKED_IN'));
    if (await Admission.exists({ companyId: req.companyId, patientId, status: 'admitted' })) {
      return next(new AppError('This patient is currently admitted. Add charges and orders on their admission.', 400));
    }

    const settings = await getSettings(req.companyId);
    const type = ['outpatient', 'emergency', 'follow_up', 'antenatal'].includes(req.body.type) ? req.body.type : 'outpatient';
    const priority = ['normal', 'urgent', 'emergency'].includes(req.body.priority) ? req.body.priority : (type === 'emergency' ? 'emergency' : 'normal');
    const visit = new HospitalVisit({
      companyId: req.companyId,
      patientId,
      visitNumber: await nextNumber(req.companyId, 'visit'),
      date: today,
      queueNumber: await nextQueueNumber(req.companyId, today),
      type, priority,
      department: String(req.body.department || '').slice(0, 120) || settings.departments[0],
      doctorId: await assertDoctor(req.companyId, req.body.doctorId),
      reason: String(req.body.reason || '').slice(0, 500),
      checkedInBy: req.user._id,
      appointmentId: mongoose.isValidObjectId(appointmentId) ? appointmentId : undefined,
    });
    stamp(visit, 'waiting', req.user._id);
    await visit.save();

    // Consultation fee, if the desk chose one.
    const service = req.body.serviceId && settings.services.id(req.body.serviceId);
    if (service && service.active !== false && service.price > 0) {
      const billId = await billForVisit(req.companyId, visit, patient, req.user._id);
      await addCharges(req.companyId, billId, [{ category: service.category === 'registration' ? 'registration' : 'consultation', description: service.name, unitPrice: service.price, refType: 'service', refId: service._id }], req.user._id);
    }
    if (visit.appointmentId) {
      await HospitalAppointment.updateOne({ _id: visit.appointmentId, companyId: req.companyId }, { $set: { status: 'checked_in', visitId: visit._id } });
    }
    patient.lastVisitAt = new Date();
    await patient.save();
    emitHospital(io(req), req.companyId, 'visits', { visitId: visit._id, message: `${patient.lastName} ${patient.firstName} checked in (no. ${visit.queueNumber})` });
    res.status(201).json({ success: true, data: visit });
  } catch (err) { next(err); }
};

// GET /hospital/visits/:id — the consultation workspace.
exports.getVisit = async (req, res, next) => {
  try {
    const visit = await findOwned(HospitalVisit, req, req.params.id, 'Visit');
    await visit.populate([
      { path: 'patientId' }, { path: 'doctorId', select: 'name' }, { path: 'vitals.takenBy', select: 'name' }, { path: 'timeline.by', select: 'name' },
    ]);
    const clinical = seesClinical(req);
    const q = { companyId: req.companyId, visitId: visit._id };
    const [bill, labs, rxs, admission, history] = await Promise.all([
      visit.billId ? HospitalBill.findById(visit.billId).lean() : null,
      clinical ? LabRequest.find(q).sort({ createdAt: -1 }).populate('requestedBy', 'name').lean() : [],
      clinical ? Prescription.find(q).sort({ createdAt: -1 }).populate('prescribedBy', 'name').lean() : [],
      visit.admissionId ? Admission.findById(visit.admissionId).select('admissionNumber status wardId bedLabel admittedAt').populate('wardId', 'name').lean() : null,
      clinical ? HospitalVisit.find({ companyId: req.companyId, patientId: visit.patientId._id, _id: { $ne: visit._id } })
        .sort({ createdAt: -1 }).limit(10).select('visitNumber date type department doctorId consultation.complaint consultation.diagnoses consultation.plan status')
        .populate('doctorId', 'name').lean() : [],
    ]);
    const v = visit.toObject();
    if (!clinical) { delete v.consultation; delete v.vitals; }
    res.status(200).json({ success: true, data: { visit: v, bill, labs, prescriptions: rxs, admission, history, clinical } });
  } catch (err) { next(err); }
};

// POST /hospital/visits/:id/vitals — triage.
exports.addVitals = async (req, res, next) => {
  try {
    const visit = await findOwned(HospitalVisit, req, req.params.id, 'Visit');
    if (['completed', 'cancelled'].includes(visit.status)) return next(new AppError('This visit is closed.', 400));
    const vitals = cleanVitals(req.body);
    if (!Object.keys(vitals).length) return next(new AppError('Enter at least one reading.', 400));
    visit.vitals.push({ ...vitals, note: String(req.body.note || '').slice(0, 500), takenBy: req.user._id });
    if (req.body.priority && ['normal', 'urgent', 'emergency'].includes(req.body.priority)) visit.priority = req.body.priority;
    if (visit.status === 'waiting') { visit.status = 'triaged'; stamp(visit, 'triaged', req.user._id); }
    await visit.save();
    emitHospital(io(req), req.companyId, 'visits', { visitId: visit._id });
    res.status(200).json({ success: true, data: visit });
  } catch (err) { next(err); }
};

// PUT /hospital/visits/:id — desk changes: doctor, department, priority, reason.
exports.updateVisit = async (req, res, next) => {
  try {
    const visit = await findOwned(HospitalVisit, req, req.params.id, 'Visit');
    const body = pick(req.body, ['department', 'priority', 'reason', 'type']);
    if (body.priority && !['normal', 'urgent', 'emergency'].includes(body.priority)) delete body.priority;
    if (body.type && !['outpatient', 'emergency', 'follow_up', 'antenatal', 'inpatient'].includes(body.type)) delete body.type;
    if (req.body.doctorId !== undefined) visit.doctorId = await assertDoctor(req.companyId, req.body.doctorId || null);
    Object.assign(visit, body);
    await visit.save();
    emitHospital(io(req), req.companyId, 'visits', { visitId: visit._id });
    res.status(200).json({ success: true, data: visit });
  } catch (err) { next(err); }
};

// PUT /hospital/visits/:id/consultation — the doctor's notes. Saving starts
// the consultation; { complete: true } ends the visit.
exports.saveConsultation = async (req, res, next) => {
  try {
    const visit = await findOwned(HospitalVisit, req, req.params.id, 'Visit');
    if (visit.status === 'cancelled') return next(new AppError('This visit was cancelled.', 400));
    const body = pick(req.body, CONSULT_FIELDS);
    if (body.diagnoses !== undefined) {
      body.diagnoses = (Array.isArray(body.diagnoses) ? body.diagnoses : [])
        .filter((d) => d && String(d.text || '').trim())
        .slice(0, 20)
        .map((d) => ({ code: String(d.code || '').trim().toUpperCase().slice(0, 20), text: String(d.text).trim().slice(0, 200) }));
    }
    if (body.followUpDate === '') body.followUpDate = null;
    const c = visit.consultation || {};
    Object.assign(c, body);
    if (!c.startedAt) c.startedAt = new Date();
    visit.consultation = c;
    if (!visit.doctorId) visit.doctorId = req.user._id;
    if (['waiting', 'triaged'].includes(visit.status)) { visit.status = 'in_consultation'; stamp(visit, 'in_consultation', req.user._id); }
    if (req.body.complete && visit.status === 'in_consultation') {
      visit.status = 'completed';
      visit.consultation.completedAt = new Date();
      stamp(visit, 'completed', req.user._id);
    }
    await visit.save();
    emitHospital(io(req), req.companyId, 'visits', { visitId: visit._id });
    res.status(200).json({ success: true, data: visit });
  } catch (err) { next(err); }
};

// POST /hospital/visits/:id/status { status } — move along the queue,
// reopen, or cancel (only before any money is paid on the visit).
exports.setVisitStatus = async (req, res, next) => {
  try {
    const visit = await findOwned(HospitalVisit, req, req.params.id, 'Visit');
    const { status } = req.body;
    if (!['waiting', 'triaged', 'in_consultation', 'completed', 'cancelled'].includes(status)) return next(new AppError('Invalid status.', 400));
    if (visit.status === 'admitted') return next(new AppError('This patient is admitted. Discharge them from the ward.', 400));
    if (status === 'cancelled' && visit.billId) {
      if (await HospitalPayment.exists({ companyId: req.companyId, billId: visit.billId, voided: false })) {
        return next(new AppError('Money has been paid on this visit. Refund or void the payment first.', 400));
      }
      await HospitalBill.updateOne({ _id: visit.billId, companyId: req.companyId }, { $set: { status: 'cancelled' } });
    }
    if (status === 'completed' && visit.consultation) visit.consultation.completedAt = new Date();
    visit.status = status;
    stamp(visit, status, req.user._id);
    await visit.save();
    if (status === 'cancelled' && visit.appointmentId) await HospitalAppointment.updateOne({ _id: visit.appointmentId }, { $set: { status: 'booked', visitId: null } });
    emitHospital(io(req), req.companyId, 'visits', { visitId: visit._id });
    res.status(200).json({ success: true, data: visit });
  } catch (err) { next(err); }
};

// The bill a visit or admission charges go on.
async function billIdFor(req, { visitId, admissionId }) {
  if (admissionId) {
    const adm = await findOwned(Admission, req, admissionId, 'Admission');
    return adm.billId;
  }
  const visit = await findOwned(HospitalVisit, req, visitId, 'Visit');
  const patient = await Patient.findById(visit.patientId);
  return billForVisit(req.companyId, visit, patient, req.user._id);
}
exports.billIdFor = billIdFor;

// POST /hospital/visits/:id/charges { serviceId, quantity } or { description, unitPrice, quantity, category }
exports.addVisitCharge = async (req, res, next) => {
  try {
    const billId = await billIdFor(req, req.params.kind === 'admissions' ? { admissionId: req.params.id } : { visitId: req.params.id });
    const settings = await getSettings(req.companyId);
    let charge;
    if (req.body.serviceId) {
      const s = settings.services.id(req.body.serviceId);
      if (!s) return next(new AppError('Service not found.', 400));
      charge = { category: s.category, description: s.name, unitPrice: s.price, quantity: req.body.quantity ?? 1, refType: 'service', refId: s._id };
    } else {
      if (!String(req.body.description || '').trim()) return next(new AppError('Describe the charge.', 400));
      charge = { category: ['nursing', 'procedure', 'consultation', 'other'].includes(req.body.category) ? req.body.category : 'other', description: req.body.description, unitPrice: req.body.unitPrice, quantity: req.body.quantity ?? 1 };
    }
    const bill = await addCharges(req.companyId, billId, [charge], req.user._id);
    emitHospital(io(req), req.companyId, 'bills', { billId });
    res.status(200).json({ success: true, data: bill });
  } catch (err) { next(err); }
};

// ── Wards & beds ─────────────────────────────────────────────────────────
const bedLabels = (prefix, from, count) => Array.from({ length: count }, (_, i) => `${prefix}${from + i}`);

exports.getWards = async (req, res, next) => {
  try {
    const wards = await Ward.find({ companyId: req.companyId }).sort({ name: 1 }).lean();
    const admIds = wards.flatMap((w) => w.beds.map((b) => b.admissionId).filter(Boolean));
    const adms = await Admission.find({ _id: { $in: admIds } }).select('patientId admittedAt admissionNumber diagnosis')
      .populate('patientId', 'firstName lastName hospitalNumber gender').lean();
    const admMap = new Map(adms.map((a) => [String(a._id), a]));
    res.status(200).json({
      success: true,
      data: wards.map((w) => ({
        ...w,
        beds: w.beds.map((b) => ({ ...b, admission: b.admissionId ? admMap.get(String(b.admissionId)) || null : null })),
        occupied: w.beds.filter((b) => b.status === 'occupied').length,
      })),
    });
  } catch (err) { next(err); }
};

exports.createWard = async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return next(new AppError('Ward name is required.', 400));
    const count = Math.min(200, Math.max(0, parseInt(req.body.bedCount, 10) || 0));
    const prefix = String(req.body.bedPrefix ?? 'Bed ').slice(0, 20);
    const ward = await Ward.create({
      companyId: req.companyId, name: name.slice(0, 100),
      type: req.body.type, dailyRate: Math.max(0, round2(req.body.dailyRate)),
      beds: bedLabels(prefix, 1, count).map((label) => ({ label })),
    });
    emitHospital(io(req), req.companyId, 'wards');
    res.status(201).json({ success: true, data: ward });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A ward with that name already exists.', 400));
    next(err);
  }
};

// PUT /hospital/wards/:id { name, type, dailyRate, active, addBeds, bedPrefix, removeBedIds }
exports.updateWard = async (req, res, next) => {
  try {
    const ward = await findOwned(Ward, req, req.params.id, 'Ward');
    Object.assign(ward, pick(req.body, ['name', 'type', 'active']));
    if (req.body.dailyRate !== undefined) ward.dailyRate = Math.max(0, round2(req.body.dailyRate));
    const add = Math.min(200, Math.max(0, parseInt(req.body.addBeds, 10) || 0));
    if (add) {
      const prefix = String(req.body.bedPrefix ?? 'Bed ').slice(0, 20);
      const used = new Set(ward.beds.map((b) => b.label));
      let n = ward.beds.length + 1;
      for (let i = 0; i < add; i += 1) {
        while (used.has(`${prefix}${n}`)) n += 1;
        ward.beds.push({ label: `${prefix}${n}` });
        used.add(`${prefix}${n}`);
      }
    }
    if (Array.isArray(req.body.removeBedIds) && req.body.removeBedIds.length) {
      const remove = new Set(req.body.removeBedIds.map(String));
      if (ward.beds.some((b) => remove.has(String(b._id)) && b.status === 'occupied')) return next(new AppError('Occupied beds cannot be removed.', 400));
      ward.beds = ward.beds.filter((b) => !remove.has(String(b._id)));
    }
    await ward.save();
    emitHospital(io(req), req.companyId, 'wards');
    res.status(200).json({ success: true, data: ward });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A ward with that name already exists.', 400));
    next(err);
  }
};

// PUT /hospital/wards/:id/beds/:bedId { status: available|cleaning|maintenance, label }
exports.updateBed = async (req, res, next) => {
  try {
    const ward = await findOwned(Ward, req, req.params.id, 'Ward');
    const bed = ward.beds.id(req.params.bedId);
    if (!bed) return next(new AppError('Bed not found.', 404));
    if (req.body.status) {
      if (!['available', 'cleaning', 'maintenance'].includes(req.body.status)) return next(new AppError('Invalid bed status.', 400));
      if (bed.status === 'occupied') return next(new AppError('Discharge or transfer the patient first.', 400));
      bed.status = req.body.status;
    }
    if (req.body.label) bed.label = String(req.body.label).trim().slice(0, 30);
    await ward.save();
    emitHospital(io(req), req.companyId, 'wards');
    res.status(200).json({ success: true, data: ward });
  } catch (err) { next(err); }
};

exports.deleteWard = async (req, res, next) => {
  try {
    const ward = await findOwned(Ward, req, req.params.id, 'Ward');
    if (ward.beds.some((b) => b.status === 'occupied')) return next(new AppError('This ward has patients in it.', 400));
    if (await Admission.exists({ companyId: req.companyId, 'stays.wardId': ward._id })) {
      ward.active = false; // keep for old admissions' records
      await ward.save();
    } else await ward.deleteOne();
    emitHospital(io(req), req.companyId, 'wards');
    res.status(200).json({ success: true, message: 'Ward removed.' });
  } catch (err) { next(err); }
};

// Takes a bed atomically, so two nurses can't put two patients in it.
async function claimBed(companyId, wardId, bedId, admissionId) {
  if (!mongoose.isValidObjectId(wardId) || !mongoose.isValidObjectId(bedId)) throw new AppError('Choose a ward and bed.', 400);
  const ward = await Ward.findOneAndUpdate(
    { _id: wardId, companyId, active: true, beds: { $elemMatch: { _id: bedId, status: 'available' } } },
    { $set: { 'beds.$.status': 'occupied', 'beds.$.admissionId': admissionId } },
    { new: true },
  );
  if (!ward) throw new AppError('That bed is no longer available. Choose another.', 409);
  return { ward, bed: ward.beds.id(bedId) };
}

// After discharge the bed needs cleaning before the next patient.
const releaseBed = (companyId, wardId, bedId) => Ward.updateOne(
  { _id: wardId, companyId, 'beds._id': bedId },
  { $set: { 'beds.$.status': 'cleaning', 'beds.$.admissionId': null } },
);

// ── Admissions ───────────────────────────────────────────────────────────
const daysBetween = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / DAY));

function bedEstimate(adm, now = new Date()) {
  const stays = (adm.stays || []).map((s) => ({ ...s, days: daysBetween(s.from, s.to || now) }));
  const total = stays.reduce((a, s) => a + s.days, 0);
  if (stays.length && total === 0) stays[stays.length - 1].days = 1; // a stay is at least one day
  return { stays, days: Math.max(1, total), amount: round2(stays.reduce((a, s) => a + s.days * (s.dailyRate || 0), 0)) };
}

exports.getAdmissions = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId, status: req.query.status === 'discharged' ? 'discharged' : (req.query.status === 'all' ? { $exists: true } : 'admitted') };
    if (mongoose.isValidObjectId(req.query.wardId)) filter.wardId = req.query.wardId;
    const adms = await Admission.find(filter).sort({ admittedAt: -1 }).limit(300).select('-chart')
      .populate('patientId', 'firstName lastName hospitalNumber gender dateOfBirth').populate('wardId', 'name').populate('doctorId', 'name').lean();
    res.status(200).json({ success: true, data: adms.map((a) => ({ ...a, estimate: bedEstimate(a, a.discharge?.at || new Date()) })) });
  } catch (err) { next(err); }
};

exports.getAdmission = async (req, res, next) => {
  try {
    const adm = await findOwned(Admission, req, req.params.id, 'Admission');
    await adm.populate([{ path: 'patientId' }, { path: 'wardId', select: 'name dailyRate' }, { path: 'doctorId', select: 'name' }, { path: 'chart.by', select: 'name' }, { path: 'admittedBy', select: 'name' }, { path: 'discharge.by', select: 'name' }]);
    const clinical = seesClinical(req);
    const or = [{ admissionId: adm._id }, ...(adm.visitId ? [{ visitId: adm.visitId }] : [])];
    const [bill, labs, rxs, visit] = await Promise.all([
      adm.billId ? HospitalBill.findById(adm.billId).lean() : null,
      clinical ? LabRequest.find({ companyId: req.companyId, $or: or }).sort({ createdAt: -1 }).populate('requestedBy', 'name').lean() : [],
      clinical ? Prescription.find({ companyId: req.companyId, $or: or }).sort({ createdAt: -1 }).populate('prescribedBy', 'name').lean() : [],
      adm.visitId ? HospitalVisit.findById(adm.visitId).select('visitNumber consultation.diagnoses consultation.complaint').lean() : null,
    ]);
    const a = adm.toObject();
    if (!clinical) delete a.chart;
    res.status(200).json({ success: true, data: { admission: a, estimate: bedEstimate(a, a.discharge?.at || new Date()), bill, labs, prescriptions: rxs, visit, clinical } });
  } catch (err) { next(err); }
};

// POST /hospital/admissions { visitId | patientId, wardId, bedId, reason, diagnosis, doctorId }
exports.admit = async (req, res, next) => {
  try {
    let visit = req.body.visitId ? await findOwned(HospitalVisit, req, req.body.visitId, 'Visit') : null;
    const patientId = visit ? visit.patientId : req.body.patientId;
    if (!mongoose.isValidObjectId(patientId)) return next(new AppError('Choose a patient.', 400));
    const patient = await Patient.findOne({ _id: patientId, companyId: req.companyId });
    if (!patient) return next(new AppError('Patient not found.', 404));
    if (await Admission.exists({ companyId: req.companyId, patientId, status: 'admitted' })) return next(new AppError('This patient is already admitted.', 400));

    const doctorId = await assertDoctor(req.companyId, req.body.doctorId || visit?.doctorId || null);
    const admissionId = new mongoose.Types.ObjectId();
    const { ward, bed } = await claimBed(req.companyId, req.body.wardId, req.body.bedId, admissionId);
    try {
      // Direct admissions (emergency, transfers in) get a visit of their own
      // so every charge still lands on one bill.
      if (!visit) {
        const today = todayStr();
        visit = new HospitalVisit({
          companyId: req.companyId, patientId, visitNumber: await nextNumber(req.companyId, 'visit'), date: today,
          queueNumber: await nextQueueNumber(req.companyId, today), type: 'inpatient', department: req.body.department,
          doctorId, reason: req.body.reason, checkedInBy: req.user._id,
        });
        await visit.save();
      }
      const billId = await billForVisit(req.companyId, visit, patient, req.user._id);
      const adm = await Admission.create({
        _id: admissionId,
        companyId: req.companyId,
        admissionNumber: await nextNumber(req.companyId, 'admission'),
        patientId, visitId: visit._id, billId,
        wardId: ward._id, bedId: bed._id, bedLabel: bed.label,
        stays: [{ wardId: ward._id, wardName: ward.name, bedId: bed._id, bedLabel: bed.label, dailyRate: ward.dailyRate, from: new Date() }],
        doctorId,
        reason: String(req.body.reason || '').slice(0, 1000),
        diagnosis: String(req.body.diagnosis || visit.consultation?.diagnoses?.map((d) => d.text).join(', ') || '').slice(0, 500),
        admittedBy: req.user._id,
      });
      visit.status = 'admitted';
      visit.admissionId = adm._id;
      stamp(visit, 'admitted', req.user._id);
      await visit.save();
      emitHospital(io(req), req.companyId, 'wards', { admissionId: adm._id, message: `${patient.lastName} ${patient.firstName} admitted to ${ward.name}, ${bed.label}` });
      emitHospital(io(req), req.companyId, 'visits', { visitId: visit._id });
      res.status(201).json({ success: true, data: adm });
    } catch (err) {
      await Ward.updateOne({ _id: ward._id, 'beds._id': bed._id }, { $set: { 'beds.$.status': 'available', 'beds.$.admissionId': null } });
      throw err;
    }
  } catch (err) { next(err); }
};

// POST /hospital/admissions/:id/chart { kind, vitals | text | drug, dose, route, intake, output }
exports.addChartEntry = async (req, res, next) => {
  try {
    const adm = await findOwned(Admission, req, req.params.id, 'Admission');
    if (adm.status !== 'admitted') return next(new AppError('This patient has been discharged.', 400));
    const kind = ['vitals', 'note', 'medication', 'doctor'].includes(req.body.kind) ? req.body.kind : 'note';
    const entry = { kind, by: req.user._id, at: req.body.at ? new Date(req.body.at) : new Date() };
    if (Number.isNaN(entry.at.getTime()) || entry.at > new Date(Date.now() + 5 * 60000)) entry.at = new Date();
    if (kind === 'vitals') {
      const v = cleanVitals(req.body.vitals || req.body);
      delete v.weight; delete v.height; delete v.bmi;
      if (!Object.keys(v).length && num(req.body.intake) === undefined && num(req.body.output) === undefined) return next(new AppError('Enter at least one reading.', 400));
      entry.vitals = v;
      entry.intake = num(req.body.intake);
      entry.output = num(req.body.output);
    } else if (kind === 'medication') {
      if (!String(req.body.drug || '').trim()) return next(new AppError('Which drug was given?', 400));
      Object.assign(entry, pick(req.body, ['drug', 'dose', 'route', 'text']));
    } else {
      if (!String(req.body.text || '').trim()) return next(new AppError('Write the note.', 400));
      entry.text = req.body.text;
    }
    adm.chart.push(entry);
    await adm.save();
    emitHospital(io(req), req.companyId, 'wards', { admissionId: adm._id });
    res.status(201).json({ success: true, data: adm.chart[adm.chart.length - 1] });
  } catch (err) { next(err); }
};

// POST /hospital/admissions/:id/transfer { wardId, bedId }
exports.transfer = async (req, res, next) => {
  try {
    const adm = await findOwned(Admission, req, req.params.id, 'Admission');
    if (adm.status !== 'admitted') return next(new AppError('This patient has been discharged.', 400));
    if (String(req.body.bedId) === String(adm.bedId)) return next(new AppError('The patient is already in that bed.', 400));
    const { ward, bed } = await claimBed(req.companyId, req.body.wardId, req.body.bedId, adm._id);
    const old = { wardId: adm.wardId, bedId: adm.bedId };
    const now = new Date();
    const last = adm.stays[adm.stays.length - 1];
    if (last && !last.to) last.to = now;
    adm.stays.push({ wardId: ward._id, wardName: ward.name, bedId: bed._id, bedLabel: bed.label, dailyRate: ward.dailyRate, from: now });
    Object.assign(adm, { wardId: ward._id, bedId: bed._id, bedLabel: bed.label });
    adm.chart.push({ kind: 'note', text: `Transferred to ${ward.name}, ${bed.label}`, by: req.user._id });
    await adm.save();
    await releaseBed(req.companyId, old.wardId, old.bedId);
    emitHospital(io(req), req.companyId, 'wards', { admissionId: adm._id });
    res.status(200).json({ success: true, data: adm });
  } catch (err) { next(err); }
};

// POST /hospital/admissions/:id/discharge { outcome, summary, instructions, followUpDate }
// Bills each ward stay's bed days and frees the bed for cleaning.
exports.discharge = async (req, res, next) => {
  try {
    const adm = await findOwned(Admission, req, req.params.id, 'Admission');
    if (adm.status !== 'admitted') return next(new AppError('Already discharged.', 400));
    const outcome = ['improved', 'recovered', 'referred', 'against_advice', 'deceased', 'other'].includes(req.body.outcome) ? req.body.outcome : 'improved';
    const now = new Date();
    const last = adm.stays[adm.stays.length - 1];
    if (last && !last.to) last.to = now;
    const est = bedEstimate(adm.toObject(), now);
    const charges = est.stays.filter((s) => s.days > 0 && s.dailyRate > 0).map((s) => ({
      category: 'bed', description: `Bed: ${s.wardName}, ${s.bedLabel} (${s.days} day${s.days === 1 ? '' : 's'})`,
      quantity: s.days, unitPrice: s.dailyRate, refType: 'admission', refId: adm._id,
    }));
    if (adm.billId && charges.length) await addCharges(req.companyId, adm.billId, charges, req.user._id);

    adm.status = 'discharged';
    adm.discharge = {
      at: now, by: req.user._id, outcome,
      summary: String(req.body.summary || '').slice(0, 5000),
      instructions: String(req.body.instructions || '').slice(0, 2000),
      followUpDate: req.body.followUpDate || undefined,
      bedDays: est.days, bedCharge: est.amount,
    };
    await adm.save();
    await releaseBed(req.companyId, adm.wardId, adm.bedId);
    if (adm.visitId) {
      await HospitalVisit.updateOne({ _id: adm.visitId }, { $set: { status: 'completed' }, $push: { timeline: { status: 'completed', by: req.user._id, at: now } } });
    }
    if (outcome === 'deceased') await Patient.updateOne({ _id: adm.patientId, companyId: req.companyId }, { $set: { status: 'deceased' } });
    const bill = adm.billId ? await HospitalBill.findById(adm.billId).select('balance billNumber').lean() : null;
    emitHospital(io(req), req.companyId, 'wards', { admissionId: adm._id });
    emitHospital(io(req), req.companyId, 'bills', { billId: adm.billId });
    res.status(200).json({ success: true, data: { admission: adm, bill } });
  } catch (err) { next(err); }
};

exports._internal = { bedEstimate };
