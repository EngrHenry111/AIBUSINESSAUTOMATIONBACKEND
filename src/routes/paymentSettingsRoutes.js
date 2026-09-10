'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/paymentSettingsController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getPaymentSettings);
router.get('/banks', ctrl.getBanks);
router.post('/verify-account', ctrl.verifyAccount);
router.post('/setup', isManager, ctrl.createSubaccount);
router.put('/update', isManager, ctrl.updateSubaccount);

module.exports = router;
