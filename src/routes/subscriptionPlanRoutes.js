'use strict';

// Store-OWNER side of Store Subscriptions. Mounted at the API root (not
// under a single resource prefix) because the spec calls for two distinct
// resources here — /subscription-plans (the plan templates) and
// /store-subscriptions (individual subscribers) — both protected the same
// way, so one router covers both rather than two near-identical files.
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/subscriptionPlanController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/subscription-plans/subscribers', ctrl.getSubscribers);
router.get('/subscription-plans', ctrl.getPlans);
router.post('/subscription-plans', isManager, ctrl.createPlan);
router.put('/subscription-plans/:id', isManager, ctrl.updatePlan);
router.delete('/subscription-plans/:id', isManager, ctrl.deletePlan);

router.patch('/store-subscriptions/:id/pause', isManager, ctrl.pauseSubscriber);
router.patch('/store-subscriptions/:id/cancel', isManager, ctrl.cancelSubscriber);

module.exports = router;
