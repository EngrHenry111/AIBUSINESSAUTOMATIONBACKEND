'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/paymentController');
const router = express.Router();

// Webhook — no auth needed, Paystack calls this directly
router.post('/webhook', express.raw({ type: 'application/json' }), ctrl.webhook);

// All other routes require login
router.use(protect);

router.get('/plans', ctrl.getPlans);
router.post('/initialize', requireRole('company_owner', 'super_admin'), ctrl.initializePayment);
router.get('/verify/:reference', ctrl.verifyPayment);
router.get('/history', ctrl.getHistory);
router.post('/cancel', requireRole('company_owner', 'super_admin'), ctrl.cancelSubscription);

module.exports = router;
