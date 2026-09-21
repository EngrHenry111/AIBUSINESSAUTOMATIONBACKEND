'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/payrollController');

const router = express.Router();
// Salary data is sensitive — the whole module (reads included) is
// manager-and-above, unlike expenses/orders which any team member can see.
router.use(protect, enforceTenant, isManager);

router.get('/staff', ctrl.getStaff);
router.post('/staff', ctrl.addStaff);
router.put('/staff/:id', ctrl.updateStaff);
router.delete('/staff/:id', ctrl.removeStaff);

router.post('/generate', ctrl.generatePayroll);
router.get('/', ctrl.getPayrolls);
router.get('/:id', ctrl.getPayroll);
router.patch('/:id/mark-paid', ctrl.markAsPaid);
router.patch('/:id/employees/:employeeId/mark-paid', ctrl.markEmployeePaid);
router.get('/:id/payslip/:employeeId', ctrl.generatePayslip);

module.exports = router;
