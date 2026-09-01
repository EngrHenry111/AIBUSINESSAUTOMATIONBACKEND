'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/leadController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/', ctrl.getLeads);
router.post('/', ctrl.createLead);
router.get('/:id', ctrl.getLead);
router.put('/:id', ctrl.updateLead);
router.delete('/:id', ctrl.deleteLead);
router.post('/:id/analyze', aiLimiter, ctrl.analyzeLead);
router.post('/bulk-analyze', aiLimiter, ctrl.bulkAnalyzeLeads);

module.exports = router;
