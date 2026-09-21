'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { publicStoreLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/cardController');

const router = express.Router();

// ── PUBLIC — no account needed, must load fast ─────────────────────────────
router.get('/:username', publicStoreLimiter, ctrl.getCard);
router.get('/:username/vcard', publicStoreLimiter, ctrl.generateVCard);
router.get('/:username/qrcode', publicStoreLimiter, ctrl.getCardQRCode);
router.post('/:username/save', publicStoreLimiter, ctrl.saveContact);

// ── PROTECTED — the signed-in user managing their own card ────────────────
router.get('/me/settings', protect, ctrl.getMyCard);
router.patch('/me/settings', protect, ctrl.updateMyCard);

module.exports = router;
