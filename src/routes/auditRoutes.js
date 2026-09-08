'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/auditController');

const router = express.Router();

// Company owners / managers only
router.use(protect, enforceTenant, requireRole('company_owner', 'manager', 'super_admin'));

router.get('/', ctrl.getAuditLogs);
router.get('/export', ctrl.exportAuditLogs);

module.exports = router;
