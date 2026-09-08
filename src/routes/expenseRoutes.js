'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { uploadReceipt } = require('../config/cloudinary');
const ctrl = require('../controllers/expenseController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getExpenses);
router.post('/', uploadReceipt.single('receipt'), ctrl.createExpense);
router.get('/summary', ctrl.getExpenseSummary);
router.get('/profit-loss', ctrl.getProfitLoss);

router.get('/:id', ctrl.getExpense);
router.put('/:id', uploadReceipt.single('receipt'), ctrl.updateExpense);
router.delete('/:id', ctrl.deleteExpense);

module.exports = router;
