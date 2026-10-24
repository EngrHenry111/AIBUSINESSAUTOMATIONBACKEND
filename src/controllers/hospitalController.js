'use strict';

const mongoose = require('mongoose');
const HospitalStaff = require('../models/HospitalStaff');
const Patient = require('../models/Patient');
const HospitalVisit = require('../models/HospitalVisit');
const HospitalAppointment = require('../models/HospitalAppointment');
const HospitalBill = require('../models/HospitalBill');
const HospitalPayment = require('../models/HospitalPayment');
const LabRequest = require('../models/LabRequest');
const Prescription = require('../models/Prescription');
const PharmacyItem = require('../models/PharmacyItem');
const Admission = require('../models/Admission');
const Ward = require('../models/Ward');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const { seesClinical, MANAGER_ROLES } = require('../utils/hospitalAccess');
const {
  round2, oid, escapeRe, todayStr, getSettings, nextNumber, emitHospital, createBill, addCharges,
} = require('../utils/hospital');

const io = (req) => req.app.get('io');
const SETTINGS_FIELDS = ['hospitalName', 'address', 'phone', 'email', 'logo', 'patientNumberPrefix', 'chargeRegistration', 'departments', 'services', 'hmos', 'payBeforeLab', 'payBeforePharmacy'];
const PATIENT_FIELDS = [
  'firstName', 'lastName', 'otherNames', 'gender', 'dateOfBirth', 'phone', 'email', 'address', 'occupation', 'maritalStatus',
  'stateOfOrigin', 'religion', 'bloodGroup', 'genotype', 'allergies', 'chronicConditions', 'medicalNotes', 'nextOfKin', 'insurance', 'photo', 'status',
];
const APPOINTMENT_FIELDS = ['patientId', 'doctorId', 'department', 'date', 'time', 'reason'];

async function findOwned(Model, req, id = req.params.id, label = 'Record') {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${label} not found.`, 404);
  const doc = await Model.findOne({ _id: id, companyId: req.companyId });
  if (!doc) throw new AppError(`${label} not found.`, 404);
  return doc;
}
exports.findOwned = findOwned;

const list = (v, max = 30) => [...new Set((Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim()).filter(Boolean))].slice(0, max);

// ── Settings ─────────────────────────────────────────────────────────────
exports.getSettings = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getSettings(req.companyId) });
  } catch (err) { next(err); }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const body = pick(req.body, SETTINGS_FIELDS);
    if (body.departments !== undefined) body.departments = list(body.departments, 40);
    if (body.services !== undefined) {
      body.services = (Array.isArray(body.services) ? body.services : [])
        .filter((s) => s && String(s.name || '').trim())
        .slice(0, 200)
        .map((s) => ({
          ...(mongoose.isValidObjectId(s._id) && { _id: s._id }),
          name: String(s.name).trim().slice(0, 120),
          category: ['registration', 'consultation', 'nursing', 'procedure', 'other'].includes(s.category) ? s.category : 'other',
          price: Math.max(0, round2(s.price)),
          active: s.active !== false,
        }));
    }
    if (body.hmos !== undefined) {
      body.hmos = (Array.isArray(body.hmos) ? body.hmos : [])
        .filter((h) => h && String(h.name || '').trim())
        .slice(0, 100)
        .map((h) => ({
          ...(mongoose.isValidObjectId(h._id) && { _id: h._id }),
          name: String(h.name).trim().slice(0, 120),
          coverPercent: Math.min(100, Math.max(0, Number(h.coverPercent) || 0)),
          phone: String(h.phone || '').slice(0, 40),
          email: String(h.email || '').toLowerCase().slice(0, 200),
          active: h.active !== false,
        }));
    }
    if (body.services !== undefined) body.pricesConfirmed = true;
    Object.assign(settings, body);
    await settings.save();
    emitHospital(io(req), req.companyId, 'settings');
    res.status(200).json({ success: true, data: settings });
  } catch (err) { next(err); }
};

// ── Me & staff ───────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  res.status(200).json({ success: true, data: { role: req.hospital.role, manager: req.hospital.manager, department: req.hospital.department || null } });
};

exports.getStaff = async (req, res, next) => {
  try {
    const [users, roles] = await Promise.all([
      User.find({ companyId: req.companyId, status: { $ne: 'deleted' }, role: { $ne: 'customer' } }).select('name email role status').sort({ name: 1 }).lean(),
      HospitalStaff.find({ companyId: req.companyId }).lean(),
    ]);
    const byUser = new Map(roles.map((r) => [String(r.userId), r]));
    res.status(200).json({
      success: true,
      data: users.map((u) => {
        const r = byUser.get(String(u._id));
        const owner = MANAGER_ROLES.includes(u.role);
        return {
          _id: u._id, name: u.name, email: u.email, accountRole: u.role, status: u.status,
          hospitalRole: owner ? 'owner' : (r?.role || null), department: r?.department || '', title: r?.title || '',
        };
      }),
    });
  } catch (err) { next(err); }
};

// PUT /hospital/staff/:userId { role, department, title } — role null removes it.
exports.setStaffRole = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) return next(new AppError('Team member not found.', 404));
    const user = await User.findOne({ _id: userId, companyId: req.companyId }).select('role').lean();
    if (!user) return next(new AppError('Team member not found.', 404));
    if (MANAGER_ROLES.includes(user.role)) return next(new AppError('Owners and managers always have full access.', 400));
    const { role } = req.body;
    if (role == null || role === '') {
      await HospitalStaff.deleteOne({ companyId: req.companyId, userId });
    } else {
      if (!HospitalStaff.ROLES.includes(role)) return next(new AppError(`Role must be one of: ${HospitalStaff.ROLES.join(', ')}.`, 400));
      await HospitalStaff.findOneAndUpdate(
        { companyId: req.companyId, userId },
        { $set: { role, department: String(req.body.department || '').slice(0, 120), title: String(req.body.title || '').slice(0, 60) } },
        { upsert: true },
      );
    }
    emitHospital(io(req), req.companyId, 'staff', { userId });
    res.status(200).json({ success: true, data: { userId, role: role || null } });
  } catch (err) { next(err); }
};

// Doctors for pickers: team members with the doctor role, plus anyone with
// full access (owners often consult in small clinics).
exports.getDoctors = async (req, res, next) => {
  try {
    const [roles, users] = await Promise.all([
      HospitalStaff.find({ companyId: req.companyId }).lean(),
      User.find({ companyId: req.companyId, status: { $ne: 'deleted' }, role: { $ne: 'customer' } }).select('name role').sort({ name: 1 }).lean(),
    ]);
    const byUser = new Map(roles.map((r) => [String(r.userId), r]));
    const doctors = users.filter((u) => {
      const r = byUser.get(String(u._id));
      return r ? r.role === 'doctor' : true;
    }).map((u) => {
      const r = byUser.get(String(u._id));
      return { _id: u._id, name: u.name, department: r?.department || '', title: r?.title || '', isDoctor: r?.role === 'doctor' };
    });
    res.status(200).json({ success: true, data: doctors.sort((a, b) => Number(b.isDoctor) - Number(a.isDoctor)) });
  } catch (err) { next(err); }
};

// ── Dashboard ────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res, next) => {
  try {
    const cid = oid(req.companyId);
    const today = todayStr();
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const since30 = new Date(startOfDay.getTime() - 29 * 86400000);
    const in60 = new Date(Date.now() + 60 * 86400000);
    const settings = await getSettings(req.companyId);

    const [visitsToday, newPatients, totalPatients, apptsToday, labPending, rxPending, admitted, wards, paidToday, daily, outstanding, lowStock, expiring, queue, recentPayments] = await Promise.all([
      HospitalVisit.aggregate([{ $match: { companyId: cid, date: today } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Patient.countDocuments({ companyId: req.companyId, createdAt: { $gte: startOfDay } }),
      Patient.countDocuments({ companyId: req.companyId, status: { $ne: 'deceased' } }),
      HospitalAppointment.countDocuments({ companyId: req.companyId, date: today, status: 'booked' }),
      LabRequest.aggregate([{ $match: { companyId: cid, status: { $in: ['requested', 'collected'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Prescription.aggregate([{ $match: { companyId: cid, status: { $in: ['pending', 'billed'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Admission.countDocuments({ companyId: req.companyId, status: 'admitted' }),
      Ward.find({ companyId: req.companyId, active: true }).select('name beds.status').lean(),
      HospitalPayment.aggregate([{ $match: { companyId: cid, voided: false, paidAt: { $gte: startOfDay } } }, { $group: { _id: null, amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      HospitalPayment.aggregate([
        { $match: { companyId: cid, voided: false, paidAt: { $gte: since30 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: process.env.HOSPITAL_TZ || 'Africa/Lagos' } }, amount: { $sum: '$amount' } } },
      ]),
      HospitalBill.aggregate([{ $match: { companyId: cid, status: { $in: ['unpaid', 'partial'] } } }, { $group: { _id: null, amount: { $sum: '$balance' }, n: { $sum: 1 } } }]),
      PharmacyItem.countDocuments({ companyId: req.companyId, active: true, $expr: { $lte: ['$stock', '$reorderLevel'] } }),
      PharmacyItem.countDocuments({ companyId: req.companyId, active: true, batches: { $elemMatch: { quantity: { $gt: 0 }, expiresAt: { $lte: in60 } } } }),
      HospitalVisit.find({ companyId: req.companyId, date: today, status: { $in: ['waiting', 'triaged', 'in_consultation'] } })
        .sort({ priority: -1, queueNumber: 1 }).limit(10).populate('patientId', 'firstName lastName hospitalNumber').populate('doctorId', 'name').lean(),
      HospitalPayment.find({ companyId: req.companyId, voided: false }).sort({ paidAt: -1 }).limit(8).populate('patientId', 'firstName lastName hospitalNumber').lean(),
    ]);

    const byStatus = Object.fromEntries(visitsToday.map((v) => [v._id, v.n]));
    const beds = wards.flatMap((w) => w.beds || []);
    const dailyMap = new Map(daily.map((d) => [d._id, d.amount]));
    const days = [];
    for (let i = 29; i >= 0; i -= 1) {
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.HOSPITAL_TZ || 'Africa/Lagos' }).format(new Date(startOfDay.getTime() - i * 86400000));
      days.push({ date: key, amount: dailyMap.get(key) || 0 });
    }
    const setup = [
      { key: 'details', label: 'Add your hospital details', done: Boolean(settings.address && settings.phone), to: '/hospital/settings' },
      { key: 'prices', label: 'Check your consultation and service prices', done: Boolean(settings.pricesConfirmed), to: '/hospital/settings?tab=services' },
      { key: 'staff', label: 'Give each team member a hospital role', done: await HospitalStaff.exists({ companyId: req.companyId }).then(Boolean), to: '/hospital/staff' },
      { key: 'lab', label: 'Set up your lab test menu', done: await require('../models/LabTest').exists({ companyId: req.companyId }).then(Boolean), to: '/hospital/lab?tab=tests' },
      { key: 'pharmacy', label: 'Add drugs to the pharmacy', done: await PharmacyItem.exists({ companyId: req.companyId }).then(Boolean), to: '/hospital/pharmacy?tab=stock' },
      { key: 'wards', label: 'Add wards and beds', done: wards.length > 0, to: '/hospital/wards' },
    ];

    res.status(200).json({
      success: true,
      data: {
        hospitalName: settings.hospitalName,
        today,
        visits: { total: visitsToday.reduce((s, v) => s + v.n, 0), byStatus },
        patients: { total: totalPatients, newToday: newPatients },
        appointmentsToday: apptsToday,
        lab: Object.fromEntries(labPending.map((l) => [l._id, l.n])),
        pharmacy: Object.fromEntries(rxPending.map((r) => [r._id, r.n])),
        beds: { total: beds.length, occupied: beds.filter((b) => b.status === 'occupied').length, admitted },
        money: { today: paidToday[0] || { amount: 0, n: 0 }, outstanding: outstanding[0] || { amount: 0, n: 0 }, daily: days },
        stock: { low: lowStock, expiring },
        queue,
        recentPayments,
        setup: { steps: setup, done: setup.filter((s) => s.done).length, total: setup.length },
      },
    });
  } catch (err) { next(err); }
};

// ── Patients ─────────────────────────────────────────────────────────────
function cleanPatient(body) {
  const data = pick(body, PATIENT_FIELDS);
  if (data.allergies !== undefined) data.allergies = list(data.allergies);
  if (data.chronicConditions !== undefined) data.chronicConditions = list(data.chronicConditions);
  if (data.nextOfKin !== undefined) data.nextOfKin = pick(data.nextOfKin || {}, ['name', 'relationship', 'phone', 'address']);
  if (data.insurance !== undefined) {
    const ins = pick(data.insurance || {}, ['hmo', 'enrolleeId', 'plan', 'expiresAt']);
    if (ins.expiresAt === '') ins.expiresAt = null;
    data.insurance = ins;
  }
  if (data.dateOfBirth === '') data.dateOfBirth = null;
  if (data.gender === '') data.gender = undefined;
  return data;
}

exports.getPatients = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = { companyId: req.companyId };
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (req.query.hmo) filter['insurance.hmo'] = req.query.hmo;
    if (req.query.search) {
      const q = String(req.query.search).trim();
      const re = new RegExp(escapeRe(q), 'i');
      const digits = q.replace(/\D/g, '');
      filter.$or = [{ firstName: re }, { lastName: re }, { otherNames: re }, { hospitalNumber: re }, { 'insurance.enrolleeId': re },
        ...(digits.length >= 4 ? [{ phone: new RegExp(escapeRe(digits.slice(-10))) }] : [{ phone: re }])];
    }
    const [patients, total] = await Promise.all([
      Patient.find(filter).sort(req.query.search ? { lastName: 1, firstName: 1 } : { createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Patient.countDocuments(filter),
    ]);
    const owing = await HospitalBill.aggregate([
      { $match: { companyId: oid(req.companyId), patientId: { $in: patients.map((p) => p._id) }, status: { $in: ['unpaid', 'partial'] } } },
      { $group: { _id: '$patientId', balance: { $sum: '$balance' } } },
    ]);
    const owingMap = new Map(owing.map((o) => [String(o._id), o.balance]));
    res.status(200).json({
      success: true,
      data: patients.map((p) => ({ ...p, fullName: [p.lastName, p.firstName, p.otherNames].filter(Boolean).join(' '), balance: owingMap.get(String(p._id)) || 0 })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

exports.createPatient = async (req, res, next) => {
  try {
    const data = cleanPatient(req.body);
    if (!data.firstName || !data.lastName) return next(new AppError('First and last name are required.', 400));
    const settings = await getSettings(req.companyId);
    // Same name + phone already registered? Stop a duplicate record.
    if (data.phone && !req.body.allowDuplicate) {
      const dup = await Patient.findOne({
        companyId: req.companyId, phone: data.phone,
        lastName: new RegExp(`^${escapeRe(data.lastName)}$`, 'i'), firstName: new RegExp(`^${escapeRe(data.firstName)}$`, 'i'),
      }).select('hospitalNumber').lean();
      if (dup) return next(new AppError(`This patient may already be registered as ${dup.hospitalNumber}.`, 409, 'DUPLICATE_PATIENT'));
    }
    const hospitalNumber = String(req.body.hospitalNumber || '').trim() || await nextNumber(req.companyId, 'patient', settings);
    let patient;
    try {
      patient = await Patient.create({ ...data, hospitalNumber, companyId: req.companyId, registeredBy: req.user._id });
    } catch (err) {
      if (err.code === 11000) return next(new AppError(`Hospital number ${hospitalNumber} is already in use.`, 400));
      throw err;
    }
    // Card / registration fee on its own bill.
    let billId = null;
    const reg = settings.chargeRegistration && req.body.chargeRegistration !== false
      && settings.services.find((s) => s.active !== false && s.category === 'registration' && s.price > 0);
    if (reg) {
      const bill = await createBill(req.companyId, patient, { userId: req.user._id, settings });
      await addCharges(req.companyId, bill._id, [{ category: 'registration', description: reg.name, unitPrice: reg.price, refType: 'service', refId: reg._id }], req.user._id);
      billId = bill._id;
    }
    emitHospital(io(req), req.companyId, 'patients', { patientId: patient._id });
    res.status(201).json({ success: true, data: { patient, billId } });
  } catch (err) { next(err); }
};

exports.getPatient = async (req, res, next) => {
  try {
    const patient = await findOwned(Patient, req, req.params.id, 'Patient');
    const clinical = seesClinical(req);
    const q = { companyId: req.companyId, patientId: patient._id };
    const [visits, bills, payments, labs, rxs, admissions] = await Promise.all([
      HospitalVisit.find(q).sort({ createdAt: -1 }).limit(100).select(clinical ? '-timeline' : 'visitNumber date type department status doctorId createdAt billId')
        .populate('doctorId', 'name').lean(),
      HospitalBill.find(q).sort({ createdAt: -1 }).limit(100).lean(),
      HospitalPayment.find(q).sort({ paidAt: -1 }).limit(100).populate('recordedBy', 'name').lean(),
      clinical ? LabRequest.find(q).sort({ createdAt: -1 }).limit(100).populate('requestedBy', 'name').lean() : [],
      clinical ? Prescription.find(q).sort({ createdAt: -1 }).limit(100).populate('prescribedBy', 'name').lean() : [],
      Admission.find(q).sort({ admittedAt: -1 }).limit(50).select(clinical ? '-chart' : 'admissionNumber status admittedAt discharge.at stays wardId bedLabel').populate('wardId', 'name').lean(),
    ]);
    const outstanding = round2(bills.filter((b) => ['unpaid', 'partial'].includes(b.status)).reduce((s, b) => s + b.balance, 0));
    const p = patient.toObject();
    if (!clinical) { delete p.medicalNotes; delete p.chronicConditions; }
    res.status(200).json({ success: true, data: { patient: p, visits, bills, payments, labs, prescriptions: rxs, admissions, outstanding, clinical } });
  } catch (err) { next(err); }
};

exports.updatePatient = async (req, res, next) => {
  try {
    const patient = await findOwned(Patient, req, req.params.id, 'Patient');
    Object.assign(patient, cleanPatient(req.body));
    if (req.body.hospitalNumber && req.body.hospitalNumber !== patient.hospitalNumber) patient.hospitalNumber = String(req.body.hospitalNumber).trim();
    await patient.save();
    emitHospital(io(req), req.companyId, 'patients', { patientId: patient._id });
    res.status(200).json({ success: true, data: patient });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('That hospital number is already in use.', 400));
    next(err);
  }
};

exports.deletePatient = async (req, res, next) => {
  try {
    const patient = await findOwned(Patient, req, req.params.id, 'Patient');
    const q = { companyId: req.companyId, patientId: patient._id };
    if (await HospitalVisit.exists(q) || await HospitalPayment.exists(q)) {
      return next(new AppError('This patient has visits or payments on record. Mark them inactive instead.', 400));
    }
    await Promise.all([HospitalBill.deleteMany(q), HospitalAppointment.deleteMany(q), patient.deleteOne()]);
    emitHospital(io(req), req.companyId, 'patients');
    res.status(200).json({ success: true, message: 'Patient deleted.' });
  } catch (err) { next(err); }
};

// ── Appointments ─────────────────────────────────────────────────────────
exports.getAppointments = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayStr();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
    filter.date = { $gte: from, $lte: to };
    if (req.query.status) filter.status = req.query.status;
    if (mongoose.isValidObjectId(req.query.doctorId)) filter.doctorId = req.query.doctorId;
    if (mongoose.isValidObjectId(req.query.patientId)) { filter.patientId = req.query.patientId; delete filter.date; }
    const appts = await HospitalAppointment.find(filter).sort({ date: 1, time: 1 }).limit(1000)
      .populate('patientId', 'firstName lastName hospitalNumber phone').populate('doctorId', 'name').lean();
    res.status(200).json({ success: true, data: appts });
  } catch (err) { next(err); }
};

async function cleanAppointment(req, body) {
  const data = pick(body, APPOINTMENT_FIELDS);
  if (data.patientId !== undefined) {
    if (!mongoose.isValidObjectId(data.patientId) || !(await Patient.exists({ _id: data.patientId, companyId: req.companyId }))) throw new AppError('Choose a registered patient.', 400);
  }
  if (data.doctorId !== undefined) {
    data.doctorId = data.doctorId && mongoose.isValidObjectId(data.doctorId) && await User.exists({ _id: data.doctorId, companyId: req.companyId }) ? data.doctorId : null;
  }
  if (data.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new AppError('Choose a date.', 400);
  if (data.time && !/^\d{2}:\d{2}$/.test(data.time)) throw new AppError('Time must look like 09:30.', 400);
  return data;
}

exports.createAppointment = async (req, res, next) => {
  try {
    const data = await cleanAppointment(req, req.body);
    if (!data.patientId || !data.date) return next(new AppError('Choose the patient and date.', 400));
    const appt = await HospitalAppointment.create({ ...data, companyId: req.companyId, bookedBy: req.user._id });
    emitHospital(io(req), req.companyId, 'appointments', { appointmentId: appt._id });
    res.status(201).json({ success: true, data: appt });
  } catch (err) { next(err); }
};

exports.updateAppointment = async (req, res, next) => {
  try {
    const appt = await findOwned(HospitalAppointment, req, req.params.id, 'Appointment');
    Object.assign(appt, await cleanAppointment(req, req.body));
    if (['booked', 'cancelled', 'no_show'].includes(req.body.status) && appt.status !== 'checked_in') appt.status = req.body.status;
    await appt.save();
    emitHospital(io(req), req.companyId, 'appointments', { appointmentId: appt._id });
    res.status(200).json({ success: true, data: appt });
  } catch (err) { next(err); }
};

exports.deleteAppointment = async (req, res, next) => {
  try {
    const appt = await findOwned(HospitalAppointment, req, req.params.id, 'Appointment');
    if (appt.status === 'checked_in') return next(new AppError('This appointment is already a visit.', 400));
    await appt.deleteOne();
    emitHospital(io(req), req.companyId, 'appointments');
    res.status(200).json({ success: true, message: 'Appointment deleted.' });
  } catch (err) { next(err); }
};

