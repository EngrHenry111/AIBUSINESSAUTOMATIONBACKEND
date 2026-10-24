'use strict';

// Hospital management — patients, front desk and queue, consultations,
// laboratory, pharmacy, wards, billing and reports. Every change emits
// `hospital:update` to the company's socket room so open screens refresh.
//
// Staff access by hospital role (utils/hospitalAccess.js); admins pass every
// guard, owners/managers additionally get the isManager-only actions.
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isEmployee, isManager } = require('../middleware/roleMiddleware');
const { loadHospitalRole, allow } = require('../utils/hospitalAccess');
const hospital = require('../controllers/hospitalController');
const clinical = require('../controllers/hospitalClinicalController');
const lab = require('../controllers/hospitalLabController');
const pharmacy = require('../controllers/hospitalPharmacyController');
const billing = require('../controllers/hospitalBillingController');

const router = express.Router();
router.use(protect, enforceTenant, isEmployee, loadHospitalRole);

// Groups of roles (admin is always included by allow()).
const CLINICAL = allow('doctor', 'nurse');
const DOCTOR = allow('doctor');
const FRONT = allow('records', 'nurse', 'doctor', 'cashier');
const EVERYONE = allow('doctor', 'nurse', 'pharmacist', 'lab', 'cashier', 'records');
const LAB = allow('lab');
const LAB_ORDER = allow('doctor', 'lab', 'nurse');
const PHARM = allow('pharmacist');
const RX_ORDER = allow('doctor', 'pharmacist');
const CASH = allow('cashier');
const CHARGE = allow('doctor', 'nurse', 'cashier');
const WARD = allow('doctor', 'nurse');

router.get('/me', hospital.getMe);
router.get('/settings', hospital.getSettings);
router.put('/settings', isManager, hospital.updateSettings);
router.get('/dashboard', EVERYONE, hospital.getDashboard);
router.get('/staff', allow(), hospital.getStaff);
router.put('/staff/:userId', isManager, hospital.setStaffRole);
router.get('/doctors', hospital.getDoctors);

router.get('/patients', EVERYONE, hospital.getPatients);
router.post('/patients', FRONT, hospital.createPatient);
router.get('/patients/:id', EVERYONE, hospital.getPatient);
router.put('/patients/:id', FRONT, hospital.updatePatient);
router.delete('/patients/:id', isManager, hospital.deletePatient);

router.get('/appointments', FRONT, hospital.getAppointments);
router.post('/appointments', FRONT, hospital.createAppointment);
router.put('/appointments/:id', FRONT, hospital.updateAppointment);
router.delete('/appointments/:id', FRONT, hospital.deleteAppointment);

router.get('/visits', EVERYONE, clinical.getVisits);
router.post('/visits', FRONT, clinical.checkIn);
router.get('/visits/:id', EVERYONE, clinical.getVisit);
router.put('/visits/:id', FRONT, clinical.updateVisit);
router.post('/visits/:id/vitals', CLINICAL, clinical.addVitals);
router.put('/visits/:id/consultation', DOCTOR, clinical.saveConsultation);
router.post('/visits/:id/status', CLINICAL, clinical.setVisitStatus);
router.post('/:kind(visits|admissions)/:id/charges', CHARGE, clinical.addVisitCharge);

router.get('/wards', EVERYONE, clinical.getWards);
router.post('/wards', allow(), clinical.createWard);
router.put('/wards/:id', allow(), clinical.updateWard);
router.put('/wards/:id/beds/:bedId', WARD, clinical.updateBed);
router.delete('/wards/:id', isManager, clinical.deleteWard);

router.get('/admissions', EVERYONE, clinical.getAdmissions);
router.post('/admissions', DOCTOR, clinical.admit);
router.get('/admissions/:id', EVERYONE, clinical.getAdmission);
router.post('/admissions/:id/chart', WARD, clinical.addChartEntry);
router.post('/admissions/:id/transfer', WARD, clinical.transfer);
router.post('/admissions/:id/discharge', DOCTOR, clinical.discharge);

router.get('/lab/tests', EVERYONE, lab.getTests);
router.post('/lab/tests', LAB, lab.createTest);
router.post('/lab/tests/seed', LAB, lab.seedTests);
router.put('/lab/tests/:id', LAB, lab.updateTest);
router.delete('/lab/tests/:id', LAB, lab.deleteTest);
router.get('/lab/requests', allow('doctor', 'nurse', 'lab'), lab.getRequests);
router.post('/lab/requests', LAB_ORDER, lab.createRequest);
router.get('/lab/requests/:id', allow('doctor', 'nurse', 'lab'), lab.getRequest);
router.post('/lab/requests/:id/collect', allow('lab', 'nurse'), lab.collect);
router.put('/lab/requests/:id/results', LAB, lab.saveResults);
router.post('/lab/requests/:id/verify', LAB, lab.verify);
router.post('/lab/requests/:id/cancel', LAB_ORDER, lab.cancel);

router.get('/pharmacy/items', allow('pharmacist', 'doctor', 'nurse'), pharmacy.getItems);
router.post('/pharmacy/items', PHARM, pharmacy.createItem);
router.put('/pharmacy/items/:id', PHARM, pharmacy.updateItem);
router.post('/pharmacy/items/:id/receive', PHARM, pharmacy.receiveStock);
router.post('/pharmacy/items/:id/adjust', PHARM, pharmacy.adjustStock);
router.get('/pharmacy/items/:id/moves', PHARM, pharmacy.getMoves);
router.get('/pharmacy/prescriptions', allow('pharmacist', 'doctor', 'nurse'), pharmacy.getPrescriptions);
router.post('/pharmacy/prescriptions', RX_ORDER, pharmacy.createPrescription);
router.get('/pharmacy/prescriptions/:id', allow('pharmacist', 'doctor', 'nurse'), pharmacy.getPrescription);
router.put('/pharmacy/prescriptions/:id', DOCTOR, pharmacy.updatePrescription);
router.post('/pharmacy/prescriptions/:id/bill', PHARM, pharmacy.billPrescription);
router.post('/pharmacy/prescriptions/:id/dispense', PHARM, pharmacy.dispense);
router.post('/pharmacy/prescriptions/:id/cancel', RX_ORDER, pharmacy.cancelPrescription);

router.get('/billing/bills', CASH, billing.getBills);
router.get('/billing/bills/:id', allow('cashier', 'records', 'doctor', 'nurse', 'pharmacist', 'lab'), billing.getBill);
router.post('/billing/bills/:id/items', CHARGE, billing.addItem);
router.delete('/billing/bills/:id/items/:itemId', CASH, billing.removeItem);
router.put('/billing/bills/:id/discount', isManager, billing.setDiscount);
router.put('/billing/bills/:id/hmo', CASH, billing.setBillHmo);
router.post('/billing/bills/:id/cancel', isManager, billing.cancelBill);
router.get('/billing/payments', CASH, billing.getPayments);
router.post('/billing/payments', CASH, billing.recordPayment);
router.get('/billing/payments/:id', allow('cashier', 'records'), billing.getPayment);
router.post('/billing/payments/:id/void', isManager, billing.voidPayment);
router.get('/billing/debtors', CASH, billing.getDebtors);
router.get('/billing/claims', CASH, billing.getClaims);
router.put('/billing/claims', CASH, billing.updateClaims);

router.get('/reports', isManager, billing.getReport);

module.exports = router;
