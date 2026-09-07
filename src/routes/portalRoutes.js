'use strict';

const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validateMiddleware');
const { authLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/portalController');

const router = express.Router();

// All routes are public — the portal has its own token-based auth.
router.post('/request', authLimiter, [
  body('email').isEmail().withMessage('A valid email is required'),
  body('companyId').notEmpty().withMessage('Company is required'),
], validate, ctrl.requestAccess);

router.get('/verify', ctrl.verifyToken);
router.get('/data', ctrl.getPortalData);
router.get('/invoices/:id/pdf', ctrl.getInvoicePdf);

module.exports = router;
