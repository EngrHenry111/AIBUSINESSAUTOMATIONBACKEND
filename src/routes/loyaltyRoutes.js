'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/loyaltyController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/program', ctrl.getLoyaltyProgram);
router.post('/program', isManager, ctrl.setupLoyaltyProgram);
router.get('/leaderboard', ctrl.getLeaderboard);
router.get('/stats', ctrl.getLoyaltyStats);
router.get('/customers', ctrl.getCustomerPoints);
router.get('/customers/:customerId', ctrl.getCustomerPointsById);
router.post('/award', ctrl.awardPoints);
router.post('/redeem', ctrl.redeemPoints);

module.exports = router;
