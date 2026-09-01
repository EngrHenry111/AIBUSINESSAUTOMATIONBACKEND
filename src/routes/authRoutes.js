'use strict';

const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validateMiddleware');
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/authController');
const router = express.Router();

// ── Standard Auth ─────────────────────────────────────────────────────────
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('companyName').trim().notEmpty().withMessage('Company name is required'),
], validate, ctrl.register);

router.post('/login', [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
], validate, ctrl.login);

router.post('/logout', protect, ctrl.logout);
router.post('/refresh-token', ctrl.refreshToken);
router.get('/me', protect, ctrl.getMe);

// ── Password Reset ────────────────────────────────────────────────────────
router.post('/forgot-password', [
  body('email').isEmail().withMessage('Valid email required'),
], validate, ctrl.forgotPassword);

router.post('/reset-password/:token', [
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], validate, ctrl.resetPassword);

// ── Google OAuth ──────────────────────────────────────────────────────────
// Only register these routes if Google credentials are configured
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const passport = require('passport');
  require('../config/passport');

  router.get('/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })
  );

  router.get('/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login?error=google_failed' }),
    ctrl.googleCallback
  );
} else {
  // Placeholder routes when Google OAuth not configured
  router.get('/google', (req, res) => {
    res.status(503).json({ success: false, message: 'Google OAuth not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env' });
  });
}

module.exports = router;