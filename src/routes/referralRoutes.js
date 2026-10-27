'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/referralController');

const router = express.Router();

// The referral balance belongs to the company, so only its owner sees and
// spends it.
router.use(protect, requireRole('company_owner', 'super_admin'));

router.get('/', ctrl.getMine);
router.post('/claim', ctrl.claim);
router.post('/use-balance', ctrl.useBalance);
router.post('/withdraw', ctrl.withdraw);

module.exports = router;
