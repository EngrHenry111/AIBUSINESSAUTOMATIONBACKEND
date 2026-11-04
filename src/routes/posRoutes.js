'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isEmployee, isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/posController');

// Quick Sale (selling at the counter). Any staff member can sell; only
// managers and owners can cancel a sale.
const router = express.Router();
router.use(protect, enforceTenant, isEmployee);

router.get('/products', ctrl.getProducts);
router.get('/sales', ctrl.getSales);
router.post('/sales', ctrl.createSale);
router.get('/sales/:id', ctrl.getSale);
router.post('/sales/:id/void', isManager, ctrl.voidSale);

module.exports = router;
