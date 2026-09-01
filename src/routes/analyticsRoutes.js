'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/analyticsController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/dashboard', ctrl.getDashboardMetrics);
router.get('/insights', ctrl.getAIInsights);

module.exports = router;
