'use strict';

// Laboratory: the test menu, requests from doctors (or walk-ins), sample
// collection, result entry with automatic H/L flags, and verification.

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const LabTest = require('../models/LabTest');
const LabRequest = require('../models/LabRequest');
const Admission = require('../models/Admission');
const { AppError } = require('../middleware/errorMiddleware');
const { pick } = require('../utils/pick');
const {
  round2, escapeRe, getSettings, nextNumber, emitHospital, createBill, addCharges, removeCharges, assertBillPaid, flagFor,
} = require('../utils/hospital');
const { findOwned } = require('./hospitalController');
const { billIdFor } = require('./hospitalClinicalController');

const io = (req) => req.app.get('io');
const p = (name, unit, refLow, refHigh, refText) => ({ name, unit, refLow, refHigh, refText });

// A starting menu for a Nigerian hospital lab — prices and ranges are
// editable after loading.
const COMMON_TESTS = [
  { name: 'Malaria parasite (MP)', code: 'MP', category: 'Parasitology', sampleType: 'Blood (EDTA)', price: 1500, turnaroundHours: 1, parameters: [p('Malaria parasite', '', null, null, 'Not seen'), p('Density', '/µL')] },
  { name: 'Malaria RDT', code: 'MRDT', category: 'Parasitology', sampleType: 'Blood (finger prick)', price: 1500, turnaroundHours: 1, parameters: [p('P. falciparum antigen', '', null, null, 'Negative')] },
  { name: 'Full blood count (FBC)', code: 'FBC', category: 'Haematology', sampleType: 'Blood (EDTA)', price: 5000, turnaroundHours: 4, parameters: [p('Haemoglobin', 'g/dL', 11.5, 16.5), p('PCV', '%', 36, 50), p('WBC', '×10⁹/L', 4, 11), p('Neutrophils', '%', 40, 75), p('Lymphocytes', '%', 20, 45), p('Platelets', '×10⁹/L', 150, 450)] },
  { name: 'Packed cell volume (PCV)', code: 'PCV', category: 'Haematology', sampleType: 'Blood (EDTA)', price: 1000, turnaroundHours: 1, parameters: [p('PCV', '%', 36, 50)] },
  { name: 'ESR', code: 'ESR', category: 'Haematology', sampleType: 'Blood (citrate)', price: 1500, turnaroundHours: 2, parameters: [p('ESR', 'mm/hr', 0, 20)] },
  { name: 'Blood group & Rhesus', code: 'BG', category: 'Haematology', sampleType: 'Blood (EDTA)', price: 1500, turnaroundHours: 1, parameters: [p('ABO group', ''), p('Rhesus', '')] },
  { name: 'Haemoglobin genotype', code: 'GENO', category: 'Haematology', sampleType: 'Blood (EDTA)', price: 2500, turnaroundHours: 4, parameters: [p('Genotype', '')] },
  { name: 'Widal test', code: 'WIDAL', category: 'Serology', sampleType: 'Blood (plain)', price: 2000, turnaroundHours: 2, parameters: [p('S. typhi O', 'titre', null, null, '< 1:80'), p('S. typhi H', 'titre', null, null, '< 1:80'), p('S. paratyphi AO', 'titre'), p('S. paratyphi BO', 'titre')] },
  { name: 'HIV 1 & 2 screening', code: 'RVS', category: 'Serology', sampleType: 'Blood (plain)', price: 2000, turnaroundHours: 1, parameters: [p('HIV 1 & 2', '', null, null, 'Non-reactive')] },
  { name: 'Hepatitis B surface antigen (HBsAg)', code: 'HBSAG', category: 'Serology', sampleType: 'Blood (plain)', price: 2000, turnaroundHours: 1, parameters: [p('HBsAg', '', null, null, 'Negative')] },
  { name: 'Hepatitis C antibody (HCV)', code: 'HCV', category: 'Serology', sampleType: 'Blood (plain)', price: 2500, turnaroundHours: 1, parameters: [p('Anti-HCV', '', null, null, 'Negative')] },
  { name: 'VDRL (syphilis)', code: 'VDRL', category: 'Serology', sampleType: 'Blood (plain)', price: 2000, turnaroundHours: 1, parameters: [p('VDRL', '', null, null, 'Non-reactive')] },
  { name: 'Pregnancy test (urine hCG)', code: 'PT', category: 'Serology', sampleType: 'Urine', price: 1000, turnaroundHours: 1, parameters: [p('Urine hCG', '', null, null, 'Negative')] },
  { name: 'H. pylori antigen', code: 'HPY', category: 'Serology', sampleType: 'Stool', price: 3000, turnaroundHours: 2, parameters: [p('H. pylori antigen', '', null, null, 'Negative')] },
  { name: 'Fasting blood sugar (FBS)', code: 'FBS', category: 'Chemistry', sampleType: 'Blood (fluoride)', price: 1500, turnaroundHours: 1, parameters: [p('Glucose (fasting)', 'mmol/L', 3.9, 5.6)] },
  { name: 'Random blood sugar (RBS)', code: 'RBS', category: 'Chemistry', sampleType: 'Blood (fluoride)', price: 1500, turnaroundHours: 1, parameters: [p('Glucose (random)', 'mmol/L', 3.9, 7.8)] },
  { name: 'HbA1c', code: 'HBA1C', category: 'Chemistry', sampleType: 'Blood (EDTA)', price: 8000, turnaroundHours: 24, parameters: [p('HbA1c', '%', 4, 5.6)] },
  { name: 'Electrolytes, urea & creatinine (E/U/Cr)', code: 'EUCR', category: 'Chemistry', sampleType: 'Blood (lithium heparin)', price: 8000, turnaroundHours: 6, parameters: [p('Sodium', 'mmol/L', 135, 145), p('Potassium', 'mmol/L', 3.5, 5.1), p('Chloride', 'mmol/L', 98, 107), p('Bicarbonate', 'mmol/L', 22, 29), p('Urea', 'mmol/L', 2.5, 7.1), p('Creatinine', 'µmol/L', 62, 115)] },
  { name: 'Liver function test (LFT)', code: 'LFT', category: 'Chemistry', sampleType: 'Blood (plain)', price: 8000, turnaroundHours: 6, parameters: [p('Total bilirubin', 'µmol/L', 3, 21), p('Direct bilirubin', 'µmol/L', 0, 5), p('ALT', 'U/L', 7, 56), p('AST', 'U/L', 10, 40), p('ALP', 'U/L', 44, 147), p('Albumin', 'g/L', 35, 50), p('Total protein', 'g/L', 60, 83)] },
  { name: 'Lipid profile', code: 'LIPID', category: 'Chemistry', sampleType: 'Blood (plain, fasting)', price: 8000, turnaroundHours: 6, parameters: [p('Total cholesterol', 'mmol/L', null, 5.2), p('Triglycerides', 'mmol/L', null, 1.7), p('HDL', 'mmol/L', 1.0, null), p('LDL', 'mmol/L', null, 3.4)] },
  { name: 'Prostate specific antigen (PSA)', code: 'PSA', category: 'Chemistry', sampleType: 'Blood (plain)', price: 6000, turnaroundHours: 24, parameters: [p('Total PSA', 'ng/mL', 0, 4)] },
  { name: 'Thyroid function test (TFT)', code: 'TFT', category: 'Chemistry', sampleType: 'Blood (plain)', price: 12000, turnaroundHours: 24, parameters: [p('TSH', 'mIU/L', 0.4, 4.0), p('Free T4', 'pmol/L', 12, 22), p('Free T3', 'pmol/L', 3.1, 6.8)] },
  { name: 'Urinalysis', code: 'URINE', category: 'Microbiology', sampleType: 'Urine', price: 1500, turnaroundHours: 1, parameters: [p('Colour', ''), p('pH', '', 4.5, 8), p('Protein', '', null, null, 'Negative'), p('Glucose', '', null, null, 'Negative'), p('Ketones', '', null, null, 'Negative'), p('Blood', '', null, null, 'Negative'), p('Nitrite', '', null, null, 'Negative'), p('Leucocytes', '', null, null, 'Negative')] },
  { name: 'Urine microscopy, culture & sensitivity (Urine MCS)', code: 'UMCS', category: 'Microbiology', sampleType: 'Urine (midstream)', price: 4000, turnaroundHours: 72, parameters: [p('Microscopy', ''), p('Culture', '', null, null, 'No growth'), p('Sensitivity', '')] },
  { name: 'Stool microscopy', code: 'STOOL', category: 'Microbiology', sampleType: 'Stool', price: 1500, turnaroundHours: 2, parameters: [p('Appearance', ''), p('Ova / cysts', '', null, null, 'Not seen'), p('Occult blood', '', null, null, 'Negative')] },
  { name: 'Stool microscopy, culture & sensitivity (Stool MCS)', code: 'SMCS', category: 'Microbiology', sampleType: 'Stool', price: 4000, turnaroundHours: 72, parameters: [p('Microscopy', ''), p('Culture', '', null, null, 'No pathogen isolated'), p('Sensitivity', '')] },
  { name: 'High vaginal swab MCS (HVS)', code: 'HVS', category: 'Microbiology', sampleType: 'Swab', price: 4000, turnaroundHours: 72, parameters: [p('Microscopy', ''), p('Culture', ''), p('Sensitivity', '')] },
];

// ── Test menu ────────────────────────────────────────────────────────────
function cleanTest(body) {
  const data = pick(body, ['name', 'code', 'category', 'sampleType', 'turnaroundHours', 'active']);
  if (body.price !== undefined) data.price = Math.max(0, round2(body.price));
  if (body.parameters !== undefined) {
    const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
    data.parameters = (Array.isArray(body.parameters) ? body.parameters : [])
      .filter((x) => x && String(x.name || '').trim()).slice(0, 40)
      .map((x) => ({ name: String(x.name).trim().slice(0, 80), unit: String(x.unit || '').slice(0, 30), refLow: n(x.refLow), refHigh: n(x.refHigh), refText: String(x.refText || '').slice(0, 80) }));
  }
  return data;
}

exports.getTests = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.active !== 'all') filter.active = true;
    res.status(200).json({ success: true, data: await LabTest.find(filter).sort({ category: 1, name: 1 }).lean() });
  } catch (err) { next(err); }
};

exports.createTest = async (req, res, next) => {
  try {
    const data = cleanTest(req.body);
    if (!data.name) return next(new AppError('Test name is required.', 400));
    const test = await LabTest.create({ ...data, companyId: req.companyId });
    emitHospital(io(req), req.companyId, 'lab-tests');
    res.status(201).json({ success: true, data: test });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A test with that name already exists.', 400));
    next(err);
  }
};

exports.updateTest = async (req, res, next) => {
  try {
    const test = await findOwned(LabTest, req, req.params.id, 'Test');
    Object.assign(test, cleanTest(req.body));
    await test.save();
    emitHospital(io(req), req.companyId, 'lab-tests');
    res.status(200).json({ success: true, data: test });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A test with that name already exists.', 400));
    next(err);
  }
};

exports.deleteTest = async (req, res, next) => {
  try {
    const test = await findOwned(LabTest, req, req.params.id, 'Test');
    if (await LabRequest.exists({ companyId: req.companyId, 'tests.testId': test._id })) {
      test.active = false; // old requests still refer to it
      await test.save();
    } else await test.deleteOne();
    emitHospital(io(req), req.companyId, 'lab-tests');
    res.status(200).json({ success: true, message: 'Test removed.' });
  } catch (err) { next(err); }
};

// POST /hospital/lab/tests/seed — load the common menu (skips names already there).
exports.seedTests = async (req, res, next) => {
  try {
    const existing = new Set((await LabTest.find({ companyId: req.companyId }).select('name').lean()).map((t) => t.name.toLowerCase()));
    const docs = COMMON_TESTS.filter((t) => !existing.has(t.name.toLowerCase())).map((t) => ({
      ...t, companyId: req.companyId,
      parameters: t.parameters.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v != null))),
    }));
    if (docs.length) await LabTest.insertMany(docs, { ordered: false });
    emitHospital(io(req), req.companyId, 'lab-tests');
    res.status(200).json({ success: true, data: { added: docs.length } });
  } catch (err) { next(err); }
};

// ── Requests ─────────────────────────────────────────────────────────────
exports.getRequests = async (req, res, next) => {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.status === 'pending') filter.status = { $in: ['requested', 'collected'] };
    else if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (mongoose.isValidObjectId(req.query.patientId)) filter.patientId = req.query.patientId;
    if (req.query.search) {
      const re = new RegExp(escapeRe(String(req.query.search).trim()), 'i');
      const pts = await Patient.find({ companyId: req.companyId, $or: [{ firstName: re }, { lastName: re }, { hospitalNumber: re }] }).limit(300).distinct('_id');
      filter.$or = [{ labNumber: re }, { patientId: { $in: pts } }];
    }
    const sort = filter.status?.$in ? { priority: -1, createdAt: 1 } : { createdAt: -1 };
    const rows = await LabRequest.find(filter).sort(sort).limit(300)
      .populate('patientId', 'firstName lastName hospitalNumber gender dateOfBirth').populate('requestedBy', 'name').lean();
    const counts = await LabRequest.aggregate([{ $match: { companyId: new mongoose.Types.ObjectId(String(req.companyId)) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    res.status(200).json({ success: true, data: rows, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
  } catch (err) { next(err); }
};

exports.getRequest = async (req, res, next) => {
  try {
    const r = await findOwned(LabRequest, req, req.params.id, 'Lab request');
    await r.populate([{ path: 'patientId' }, { path: 'requestedBy', select: 'name' }, { path: 'collectedBy', select: 'name' }, { path: 'completedBy', select: 'name' }, { path: 'verifiedBy', select: 'name' }]);
    const settings = await getSettings(req.companyId);
    const bill = r.billId ? await require('../models/HospitalBill').findById(r.billId).select('billNumber balance status').lean() : null;
    res.status(200).json({
      success: true,
      data: { request: r, bill, payBeforeLab: settings.payBeforeLab, hospital: pick(settings.toObject(), ['hospitalName', 'address', 'phone', 'email', 'logo']) },
    });
  } catch (err) { next(err); }
};

// POST /hospital/lab/requests { patientId, visitId?, admissionId?, testIds, priority, clinicalNotes }
exports.createRequest = async (req, res, next) => {
  try {
    const { visitId, admissionId } = req.body;
    let patientId = req.body.patientId;
    if (admissionId) patientId = (await findOwned(Admission, req, admissionId, 'Admission')).patientId;
    else if (visitId) patientId = (await findOwned(require('../models/HospitalVisit'), req, visitId, 'Visit')).patientId;
    const patient = mongoose.isValidObjectId(patientId) && await Patient.findOne({ _id: patientId, companyId: req.companyId });
    if (!patient) return next(new AppError('Choose a patient.', 400));
    const ids = (Array.isArray(req.body.testIds) ? req.body.testIds : []).filter((id) => mongoose.isValidObjectId(id));
    const tests = await LabTest.find({ _id: { $in: ids }, companyId: req.companyId, active: true }).lean();
    if (!tests.length) return next(new AppError('Choose at least one test.', 400));

    const billId = (visitId || admissionId)
      ? await billIdFor(req, { visitId, admissionId })
      : (await createBill(req.companyId, patient, { userId: req.user._id }))._id; // walk-in
    const request = await LabRequest.create({
      companyId: req.companyId,
      labNumber: await nextNumber(req.companyId, 'lab'),
      patientId: patient._id,
      visitId: visitId || undefined,
      admissionId: admissionId || undefined,
      billId,
      tests: tests.map((t) => ({
        testId: t._id, name: t.name, category: t.category, sampleType: t.sampleType, price: t.price,
        results: t.parameters.map((x) => ({ name: x.name, unit: x.unit, refLow: x.refLow, refHigh: x.refHigh, refText: x.refText, value: '' })),
      })),
      priority: req.body.priority === 'urgent' ? 'urgent' : 'routine',
      clinicalNotes: String(req.body.clinicalNotes || '').slice(0, 1000),
      source: visitId || admissionId ? 'doctor' : 'walk_in',
      requestedBy: req.user._id,
    });
    await addCharges(req.companyId, billId, tests.filter((t) => t.price > 0).map((t) => ({
      category: 'lab', description: `Lab: ${t.name}`, unitPrice: t.price, refType: 'lab', refId: request._id,
    })), req.user._id);
    emitHospital(io(req), req.companyId, 'lab', { requestId: request._id, message: `Lab request ${request.labNumber}${request.priority === 'urgent' ? ' (URGENT)' : ''}` });
    emitHospital(io(req), req.companyId, 'bills', { billId });
    res.status(201).json({ success: true, data: request });
  } catch (err) { next(err); }
};

// POST /hospital/lab/requests/:id/collect — sample taken.
exports.collect = async (req, res, next) => {
  try {
    const r = await findOwned(LabRequest, req, req.params.id, 'Lab request');
    if (r.status !== 'requested') return next(new AppError('The sample has already been collected.', 400));
    const settings = await getSettings(req.companyId);
    if (settings.payBeforeLab && !r.admissionId) await assertBillPaid(req.companyId, r.billId, 'the sample is collected');
    r.status = 'collected';
    r.collectedBy = req.user._id;
    r.collectedAt = new Date();
    await r.save();
    emitHospital(io(req), req.companyId, 'lab', { requestId: r._id });
    res.status(200).json({ success: true, data: r });
  } catch (err) { next(err); }
};

// PUT /hospital/lab/requests/:id/results { tests: [{ _id, results: [{ name, value }], comment, done }], complete }
exports.saveResults = async (req, res, next) => {
  try {
    const r = await findOwned(LabRequest, req, req.params.id, 'Lab request');
    if (r.status === 'cancelled') return next(new AppError('This request was cancelled.', 400));
    if (r.status === 'requested') return next(new AppError('Collect the sample first.', 400));
    if (r.verifiedAt) return next(new AppError('Verified results are locked.', 400));
    for (const t of Array.isArray(req.body.tests) ? req.body.tests : []) {
      const test = r.tests.id(t._id);
      if (!test) continue;
      const values = new Map((Array.isArray(t.results) ? t.results : []).map((x) => [String(x.name), String(x.value ?? '').slice(0, 120)]));
      // Extra lines the scientist added (e.g. organisms isolated).
      for (const x of Array.isArray(t.results) ? t.results : []) {
        if (x?.name && !test.results.some((res0) => res0.name === x.name)) test.results.push({ name: String(x.name).slice(0, 80), unit: String(x.unit || '').slice(0, 30) });
      }
      test.results.forEach((line) => {
        if (values.has(line.name)) line.value = values.get(line.name);
        line.flag = flagFor(line.value, line.refLow, line.refHigh);
      });
      if (t.comment !== undefined) test.comment = String(t.comment || '').slice(0, 1000);
      if (t.done !== undefined) test.done = Boolean(t.done);
    }
    if (req.body.complete) {
      r.tests.forEach((t) => { if (t.results.some((x) => String(x.value || '').trim()) || t.comment) t.done = true; });
      if (!r.tests.every((t) => t.done)) return next(new AppError('Enter a result for every test before completing.', 400));
      r.status = 'completed';
      r.completedBy = req.user._id;
      r.completedAt = new Date();
    }
    await r.save();
    emitHospital(io(req), req.companyId, 'lab', { requestId: r._id, visitId: r.visitId, ...(req.body.complete && { message: `Results ready: ${r.labNumber}` }) });
    res.status(200).json({ success: true, data: r });
  } catch (err) { next(err); }
};

// POST /hospital/lab/requests/:id/verify — a second scientist signs off.
exports.verify = async (req, res, next) => {
  try {
    const r = await findOwned(LabRequest, req, req.params.id, 'Lab request');
    if (r.status !== 'completed') return next(new AppError('Complete the results first.', 400));
    r.verifiedBy = req.user._id;
    r.verifiedAt = new Date();
    await r.save();
    emitHospital(io(req), req.companyId, 'lab', { requestId: r._id });
    res.status(200).json({ success: true, data: r });
  } catch (err) { next(err); }
};

// POST /hospital/lab/requests/:id/cancel — takes the charges off the bill.
exports.cancel = async (req, res, next) => {
  try {
    const r = await findOwned(LabRequest, req, req.params.id, 'Lab request');
    if (r.status === 'completed') return next(new AppError('Completed results cannot be cancelled.', 400));
    if (r.status === 'cancelled') return next(new AppError('Already cancelled.', 400));
    r.status = 'cancelled';
    await r.save();
    const bill = await removeCharges(req.companyId, r.billId, 'lab', r._id);
    emitHospital(io(req), req.companyId, 'lab', { requestId: r._id });
    emitHospital(io(req), req.companyId, 'bills', { billId: r.billId });
    res.status(200).json({ success: true, data: { request: r, refundDue: bill && bill.balance < 0 ? -bill.balance : 0 } });
  } catch (err) { next(err); }
};

exports.COMMON_TESTS = COMMON_TESTS;
