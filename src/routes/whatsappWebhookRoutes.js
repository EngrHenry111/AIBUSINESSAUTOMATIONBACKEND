'use strict';

// Public — called by Meta, not by users. The POST body stays raw so its
// X-Hub-Signature-256 can be checked (see app.js: the JSON parser skips it).
const express = require('express');
const ctrl = require('../controllers/whatsappWebhookController');

const router = express.Router();

router.get('/', ctrl.verify);
router.post('/', express.raw({ type: '*/*', limit: '3mb' }), ctrl.receive);

module.exports = router;
