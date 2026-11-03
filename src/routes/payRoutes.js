'use strict';

// Public invoice pay page — no login; the link's token is the key.
const express = require('express');
const { publicStoreLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/invoicePayController');

const router = express.Router();
router.use(publicStoreLimiter);

router.get('/:token', ctrl.getInvoice);
router.post('/:token/start', ctrl.startPayment);
router.get('/:token/verify/:reference', ctrl.verifyPayment);

module.exports = router;
