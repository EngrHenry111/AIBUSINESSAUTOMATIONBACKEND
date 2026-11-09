'use strict';

const express = require('express');
const { body } = require('express-validator');
const { protect } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const { validate } = require('../middleware/validateMiddleware');
const ctrl = require('../controllers/whatsappController');

const router = express.Router();

router.use(protect);

// ── Client lifecycle ──────────────────────────────────────────────────────
router.get('/status', ctrl.getStatus);
router.get('/qr', ctrl.getQRCode);
router.post('/cloud/connect', requireRole('super_admin', 'company_owner', 'manager'), ctrl.connectCloud);
router.post('/cloud/disconnect', requireRole('super_admin', 'company_owner', 'manager'), ctrl.disconnectCloud);
router.post('/initialize', requireRole('super_admin', 'company_owner', 'manager'), ctrl.initialize);
router.post('/disconnect', requireRole('super_admin', 'company_owner', 'manager'), ctrl.disconnect);
router.post('/send-test', [body('phone').trim().notEmpty().withMessage('Phone number is required')], validate, ctrl.sendTest);

// Conversations: see /inbox (routes/inboxRoutes.js).

module.exports = router;
