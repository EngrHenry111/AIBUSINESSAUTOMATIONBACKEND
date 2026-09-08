'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/customerController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getCustomers);
router.post('/', ctrl.createCustomer);
router.get('/stats', ctrl.getCustomerStats);
router.post('/convert/:leadId', ctrl.convertLead);

router.get('/:id', ctrl.getCustomer);
router.put('/:id', ctrl.updateCustomer);
router.delete('/:id', ctrl.deleteCustomer);

module.exports = router;
