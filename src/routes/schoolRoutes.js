'use strict';

// School management — admissions, students, classes, fees (desk + online),
// attendance and results. Every change emits `school:update` to the
// company's socket room so open screens refresh immediately.
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isEmployee, isManager } = require('../middleware/roleMiddleware');
const { authLimiter, publicStoreLimiter } = require('../middleware/rateLimitMiddleware');
const school = require('../controllers/schoolController');
const fees = require('../controllers/schoolFeeController');
const academic = require('../controllers/schoolAcademicController');

const router = express.Router();

// ── Public (parents) — no login ──────────────────────────────────────────
router.get('/public/:slug', publicStoreLimiter, school.getPublicSchool);
router.post('/public/:slug/apply', authLimiter, school.publicApply);
// Lookup/pay take an admission number + guardian contact — rate limited
// tightly so they can't be used to enumerate students.
router.post('/public/:slug/fees/lookup', authLimiter, fees.publicLookup);
router.post('/public/:slug/fees/pay', authLimiter, fees.publicInitializePayment);
router.get('/public/:slug/fees/verify/:reference', publicStoreLimiter, fees.publicVerifyPayment);

// ── Staff ────────────────────────────────────────────────────────────────
router.use(protect, enforceTenant, isEmployee);

router.get('/settings', school.getSettings);
router.put('/settings', isManager, school.updateSettings);
router.get('/dashboard', school.getDashboard);

router.get('/classes', school.getClasses);
router.post('/classes', school.createClass);
router.put('/classes/:id', school.updateClass);
router.delete('/classes/:id', isManager, school.deleteClass);

router.get('/students', school.getStudents);
router.post('/students', school.createStudent);
router.post('/students/bulk', school.bulkCreateStudents);
router.post('/students/promote', isManager, school.promoteStudents);
router.get('/students/:id', school.getStudent);
router.put('/students/:id', school.updateStudent);
router.delete('/students/:id', isManager, school.deleteStudent);

router.get('/admissions', school.getApplications);
router.post('/admissions', school.createApplication);
router.get('/admissions/:id', school.getApplication);
router.put('/admissions/:id', school.updateApplication);
router.post('/admissions/:id/decision', school.decideApplication);
router.post('/admissions/:id/enroll', school.enrollApplication);
router.delete('/admissions/:id', isManager, school.deleteApplication);

router.get('/fees/structures', fees.getStructures);
router.post('/fees/structures', fees.createStructure);
router.put('/fees/structures/:id', fees.updateStructure);
router.delete('/fees/structures/:id', isManager, fees.deleteStructure);
router.post('/fees/structures/:id/generate', fees.generateBills);

router.get('/fees/bills', fees.getBills);
router.post('/fees/bills', fees.createBill);
router.put('/fees/bills/:id', fees.updateBill);
router.post('/fees/bills/:id/waive', isManager, fees.waiveBill);
router.post('/fees/bills/:id/cancel', isManager, fees.cancelBill);
router.post('/fees/bills/:id/recalculate', isManager, fees.recalculateBill);
router.get('/fees/debtors', fees.getDebtors);
router.get('/fees/summary', fees.getFeeSummary);

router.get('/fees/payments', fees.getPayments);
router.post('/fees/payments', fees.recordPayment);
router.get('/fees/payments/:id', fees.getPayment);
router.post('/fees/payments/:id/void', isManager, fees.voidPayment);

router.get('/attendance', academic.getRegister);
router.post('/attendance', academic.saveRegister);
router.get('/attendance/report', academic.getAttendanceReport);

router.get('/results/sheet', academic.getScoreSheet);
router.post('/results/sheet', academic.saveScoreSheet);
router.get('/results/broadsheet', academic.getBroadsheet);
router.get('/results/report-card/:studentId', academic.getReportCard);

module.exports = router;
