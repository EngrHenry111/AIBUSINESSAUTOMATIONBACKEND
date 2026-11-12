'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/telegramController');

const router = express.Router();
router.use(protect);

router.get('/status', ctrl.getStatus);
router.post('/connect', requireRole('super_admin', 'company_owner', 'manager'), ctrl.connect);
router.post('/disconnect', requireRole('super_admin', 'company_owner', 'manager'), ctrl.disconnect);

module.exports = router;
