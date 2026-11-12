'use strict';

// Public — called by Telegram, not by users. Each request carries the bot's
// secret header (checked in the controller). Parsed here rather than by the
// app-wide JSON parser so customers' text isn't HTML-escaped (see app.js).
const express = require('express');
const ctrl = require('../controllers/telegramWebhookController');

const router = express.Router();
router.post('/:companyId', express.json({ limit: '1mb' }), ctrl.receive);

module.exports = router;
