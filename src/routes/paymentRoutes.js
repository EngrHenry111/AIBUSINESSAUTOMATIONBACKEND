'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/paymentController');
const router = express.Router();

// Webhook — no auth needed, Paystack calls this directly. Raw body is kept for
// HMAC signature verification (app.js skips the JSON parser for this path).
router.post('/webhook', express.raw({ type: '*/*' }), ctrl.webhook);

// All other routes require login
router.use(protect);

router.get('/plans', ctrl.getPlans);
router.post('/initialize', requireRole('company_owner', 'super_admin'), ctrl.initializePayment);
router.get('/verify/:reference', ctrl.verifyPayment);
router.get('/history', ctrl.getHistory);

// Recurring subscriptions
router.post('/subscribe', requireRole('company_owner', 'super_admin'), ctrl.createSubscription);
router.get('/subscription', ctrl.getSubscriptionDetails);
router.post('/cancel-subscription', requireRole('company_owner', 'super_admin'), ctrl.cancelSubscription);
router.post('/cancel', requireRole('company_owner', 'super_admin'), ctrl.cancelSubscription);

module.exports = router;
