'use strict';

const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validateMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter } = require('../middleware/rateLimitMiddleware');
const passport = require('passport');
const { googleEnabled } = require('../config/passport');
const ctrl = require('../controllers/authController');
const router = express.Router();

const clientUrl = (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

router.post('/register', authLimiter, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('companyName').trim().notEmpty().withMessage('Company name is required'),
], validate, ctrl.register);

router.post('/login', authLimiter, [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
], validate, ctrl.login);

router.post('/logout', protect, ctrl.logout);
router.post('/refresh-token', ctrl.refreshToken);
router.get('/me', protect, ctrl.getMe);

router.post('/forgot-password', authLimiter, [
  body('email').isEmail().withMessage('Valid email required'),
], validate, ctrl.forgotPassword);

router.post('/reset-password/:token', authLimiter, [
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], validate, ctrl.resetPassword);

// ─── Google OAuth ────────────────────────────────────────────────────────────
if (googleEnabled) {
  router.get('/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })
  );

  router.get('/google/callback',
    passport.authenticate('google', {
      session: false,
      failureRedirect: `${clientUrl}/login?error=google_failed`,
    }),
    ctrl.googleCallback
  );
} else {
  // Respond with a clear 503 instead of a confusing 404 when OAuth is not set up.
  const notConfigured = (req, res) =>
    res.status(503).json({ success: false, message: 'Google sign-in is not configured on the server.' });
  router.get('/google', notConfigured);
  router.get('/google/callback', notConfigured);
}

module.exports = router;