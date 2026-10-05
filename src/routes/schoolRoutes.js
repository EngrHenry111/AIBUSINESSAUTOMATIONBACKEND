'use strict';

// School management — admissions, students, classes, fees (desk + online),
// attendance, results, timetables and reports. Every change emits
// `school:update` to the company's socket room so open screens refresh.
//
// Staff access by school role (utils/schoolAccess.js):
//   admin   — everything (owners/managers additionally get owner-only actions)
//   bursar  — fees and students
//   teacher — their own classes: register, scores, report comments
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isEmployee, isManager } = require('../middleware/roleMiddleware');
const { schoolParentLimiter, publicStoreLimiter } = require('../middleware/rateLimitMiddleware');
const { loadSchoolRole, allow } = require('../utils/schoolAccess');
const school = require('../controllers/schoolController');
const fees = require('../controllers/schoolFeeController');
const academic = require('../controllers/schoolAcademicController');
const portal = require('../controllers/schoolPortalController');
const plan = require('../controllers/schoolPlanController');
const reports = require('../controllers/schoolReportController');

const router = express.Router();

// ── Public (parents) — no login ──────────────────────────────────────────
router.get('/public/:slug', publicStoreLimiter, school.getPublicSchool);
router.post('/public/:slug/apply', schoolParentLimiter, school.publicApply);
// Lookup/pay take an admission number + guardian contact — rate limited
// tightly so they can't be used to enumerate students.
router.post('/public/:slug/fees/lookup', schoolParentLimiter, fees.publicLookup);
router.post('/public/:slug/fees/pay', schoolParentLimiter, fees.publicInitializePayment);
router.get('/public/:slug/fees/verify/:reference', publicStoreLimiter, fees.publicVerifyPayment);
// Parent portal: sign in once, then a short-lived x-parent-token header.
router.post('/public/:slug/portal/login', schoolParentLimiter, portal.login);
router.get('/public/:slug/portal/children', publicStoreLimiter, portal.getChildren);
router.get('/public/:slug/portal/children/:studentId', publicStoreLimiter, portal.getChild);
router.get('/public/:slug/portal/children/:studentId/report-card', publicStoreLimiter, portal.getReportCard);
router.get('/public/:slug/portal/children/:studentId/schedule', publicStoreLimiter, portal.getSchedule);

// ── Staff ────────────────────────────────────────────────────────────────
router.use(protect, enforceTenant, isEmployee, loadSchoolRole);
const ADMIN = allow('admin');
const FINANCE = allow('admin', 'bursar');
const ACADEMIC = allow('admin', 'teacher');

router.get('/me', school.getMe);
router.get('/settings', school.getSettings);
router.put('/settings', isManager, school.updateSettings);
router.get('/dashboard', FINANCE, school.getDashboard);
router.get('/staff', ADMIN, school.getStaff);
router.put('/staff/:userId', isManager, school.setStaffRole);

router.get('/classes', school.getClasses);
router.post('/classes', ADMIN, school.createClass);
router.put('/classes/:id', ADMIN, school.updateClass);
router.delete('/classes/:id', isManager, school.deleteClass);

router.get('/students', school.getStudents);
router.post('/students', ADMIN, school.createStudent);
router.post('/students/bulk', ADMIN, school.bulkCreateStudents);
router.post('/students/promote', isManager, school.promoteStudents);
router.get('/students/:id', school.getStudent);
router.put('/students/:id', FINANCE, school.updateStudent);
router.delete('/students/:id', isManager, school.deleteStudent);

router.get('/admissions', ADMIN, school.getApplications);
router.post('/admissions', ADMIN, school.createApplication);
router.get('/admissions/:id', ADMIN, school.getApplication);
router.put('/admissions/:id', ADMIN, school.updateApplication);
router.post('/admissions/:id/decision', ADMIN, school.decideApplication);
router.post('/admissions/:id/enroll', ADMIN, school.enrollApplication);
router.delete('/admissions/:id', isManager, school.deleteApplication);

router.get('/fees/structures', FINANCE, fees.getStructures);
router.post('/fees/structures', FINANCE, fees.createStructure);
router.put('/fees/structures/:id', FINANCE, fees.updateStructure);
router.delete('/fees/structures/:id', isManager, fees.deleteStructure);
router.post('/fees/structures/:id/generate', FINANCE, fees.generateBills);

router.get('/fees/bills', FINANCE, fees.getBills);
router.post('/fees/bills', FINANCE, fees.createBill);
router.put('/fees/bills/:id', FINANCE, fees.updateBill);
router.post('/fees/bills/:id/waive', isManager, fees.waiveBill);
router.post('/fees/bills/:id/cancel', isManager, fees.cancelBill);
router.post('/fees/bills/:id/recalculate', isManager, fees.recalculateBill);
router.get('/fees/debtors', FINANCE, fees.getDebtors);
router.get('/fees/summary', FINANCE, fees.getFeeSummary);
router.post('/fees/reminders', FINANCE, fees.sendReminders);

router.get('/fees/payments', FINANCE, fees.getPayments);
router.post('/fees/payments', FINANCE, fees.recordPayment);
router.get('/fees/payments/:id', FINANCE, fees.getPayment);
router.post('/fees/payments/:id/void', isManager, fees.voidPayment);

router.get('/attendance', ACADEMIC, academic.getRegister);
router.post('/attendance', ACADEMIC, academic.saveRegister);
router.get('/attendance/report', ACADEMIC, academic.getAttendanceReport);

router.get('/results/sheet', ACADEMIC, academic.getScoreSheet);
router.post('/results/sheet', ACADEMIC, academic.saveScoreSheet);
router.get('/results/broadsheet', ACADEMIC, academic.getBroadsheet);
router.get('/results/report-card/:studentId', ACADEMIC, academic.getReportCard);
router.put('/results/report-card/:studentId/comments', ACADEMIC, academic.saveComments);
router.get('/results/publications', academic.getPublications);
router.post('/results/publish', isManager, academic.publishResults);

router.get('/timetable', plan.getTimetable);
router.put('/timetable', ADMIN, plan.saveTimetable);
router.put('/timetable/periods', ADMIN, plan.updatePeriods);
router.get('/timetable/teacher/:userId', plan.getTeacherTimetable);
router.get('/exams', plan.getExams);
router.post('/exams', ADMIN, plan.createExams);
router.put('/exams/:id', ADMIN, plan.updateExam);
router.delete('/exams/:id', ADMIN, plan.deleteExam);

// Includes payroll and expenses — owners/managers only.
router.get('/reports/term', isManager, reports.getTermReport);

module.exports = router;
