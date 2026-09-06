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
router.post('/initialize', requireRole('super_admin', 'company_owner', 'manager'), ctrl.initialize);
router.post('/disconnect', requireRole('super_admin', 'company_owner', 'manager'), ctrl.disconnect);
router.post('/send-test', [body('phone').trim().notEmpty().withMessage('Phone number is required')], validate, ctrl.sendTest);

// ── Conversations ─────────────────────────────────────────────────────────
router.get('/conversations', ctrl.getConversations);
router.get('/conversations/:id', ctrl.getConversation);
router.post('/conversations/:id/message',
  [body('message').trim().notEmpty().withMessage('Message is required')], validate, ctrl.sendMessage);
router.post('/conversations/:id/takeover', ctrl.takeoverConversation);
router.post('/conversations/:id/resolve', ctrl.resolveConversation);
router.post('/conversations/:id/send-to-ai', ctrl.sendToAI);

module.exports = router;
