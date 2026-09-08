'use strict';

const express = require('express');
const { body } = require('express-validator');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter } = require('../middleware/rateLimitMiddleware');
const { validate } = require('../middleware/validateMiddleware');
const twoFa = require('../controllers/twoFactorController');
const auth = require('../controllers/authController');

const router = express.Router();

// Manage 2FA on your own account
router.get('/2fa/setup', protect, twoFa.setup2FA);
router.post('/2fa/verify', protect, [body('token').notEmpty()], validate, twoFa.verify2FA);
router.delete('/2fa', protect, [body('token').notEmpty()], validate, twoFa.disable2FA);

// Finish a login that was gated by 2FA (public — carries a 5-min tempToken)
router.post('/auth/2fa/complete', authLimiter,
  [body('tempToken').notEmpty(), body('token').notEmpty()], validate, auth.complete2FALogin);
router.post('/auth/2fa/backup', authLimiter,
  [body('tempToken').notEmpty(), body('code').notEmpty()], validate, twoFa.verifyBackupCode);

module.exports = router;
