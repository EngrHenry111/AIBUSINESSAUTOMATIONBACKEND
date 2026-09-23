'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/analyticsController');
const advCtrl = require('../controllers/advancedAnalyticsController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/dashboard', ctrl.getDashboardMetrics);
router.get('/insights', ctrl.getAIInsights);
router.get('/usage', ctrl.getUsage);

// ── Advanced analytics dashboard ────────────────────────────────────────────
router.get('/revenue', advCtrl.getRevenueAnalytics);
router.get('/customers', advCtrl.getCustomerAnalytics);
router.get('/products', advCtrl.getProductAnalytics);
router.get('/leads', advCtrl.getLeadAnalytics);
router.get('/financial', advCtrl.getFinancialAnalytics);
router.get('/operational', advCtrl.getOperationalAnalytics);
// Deliberately NOT at /insights — that path is the existing free, rule-based
// endpoint Dashboard.jsx polls on every load (analyticsController.getAIInsights).
// This one calls Groq and is cached 6h, so it needs its own path and its own
// rate limiter to avoid being hit on every dashboard render.
router.get('/ai-insights', aiLimiter, advCtrl.getAIInsights);

module.exports = router;
