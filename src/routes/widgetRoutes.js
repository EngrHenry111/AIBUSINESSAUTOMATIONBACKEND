'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { publicStoreLimiter, widgetMessageLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/widgetController');

const router = express.Router();

// ── PUBLIC — embedded on the client's own website, no auth ────────────────
router.get('/:companySlug/config', publicStoreLimiter, ctrl.getWidgetConfig);
router.post('/:companySlug/message', publicStoreLimiter, widgetMessageLimiter, ctrl.handleWidgetMessage);
router.get('/:companySlug/history/:sessionId', publicStoreLimiter, ctrl.getWidgetHistory);

// ── PROTECTED — business owner / team, inside the BizlyAI app ─────────────
router.get('/conversations', protect, ctrl.getWidgetConversations);
router.get('/conversations/:id', protect, ctrl.getWidgetConversation);
router.post('/conversations/:id/reply', protect, ctrl.humanReply);
router.post('/conversations/:id/takeover', protect, ctrl.takeoverConversation);
router.post('/conversations/:id/resolve', protect, ctrl.resolveConversation);
router.post('/conversations/:id/send-to-ai', protect, ctrl.sendToAI);
router.get('/settings', protect, ctrl.getWidgetSettings);
router.patch('/settings', protect, ctrl.updateWidgetSettings);

module.exports = router;
