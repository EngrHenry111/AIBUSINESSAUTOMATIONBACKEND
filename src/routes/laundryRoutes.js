'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isEmployee, isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/laundryController');

// Laundry & dry cleaning. Any staff member works the counter; only managers
// change prices or cancel a ticket.
const router = express.Router();
router.use(protect, enforceTenant, isEmployee);

router.get('/settings', ctrl.getSettings);
router.put('/settings', isManager, ctrl.updateSettings);
router.get('/customers', ctrl.findCustomer);
router.get('/orders', ctrl.listOrders);
router.post('/orders', ctrl.createOrder);
router.get('/orders/:id', ctrl.getOrder);
router.put('/orders/:id', ctrl.updateOrder);
router.post('/orders/:id/status', ctrl.setStatus);
router.post('/orders/:id/payments', ctrl.addPayment);
router.post('/orders/:id/notify', ctrl.notifyReady);
router.post('/orders/:id/cancel', isManager, ctrl.cancelOrder);

module.exports = router;
