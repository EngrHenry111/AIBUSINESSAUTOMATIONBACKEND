'use strict';

const express = require('express');
const { body } = require('express-validator');
const { protect } = require('../middleware/authMiddleware');
const { isSuperAdmin } = require('../middleware/roleMiddleware');
const { validate } = require('../middleware/validateMiddleware');
const ctrl = require('../controllers/adminController');

const router = express.Router();

// Every route in this file is super-admin only
router.use(protect, isSuperAdmin);

// ── Platform overview ──────────────────────────────────────────────────────
router.get('/stats', ctrl.getStats);
router.get('/health', ctrl.getHealth);
router.get('/revenue', ctrl.getRevenue);
router.get('/audit-logs', ctrl.getAuditLogs);

// ── Companies ──────────────────────────────────────────────────────────────
router.get('/companies', ctrl.getCompanies);
router.get('/companies/:id', ctrl.getCompany);
router.patch('/companies/:id/suspend', ctrl.suspendCompany);
router.patch('/companies/:id/activate', ctrl.activateCompany);
router.patch('/companies/:id/plan', [
  body('plan').isIn(['trial', 'starter', 'professional', 'business', 'enterprise'])
    .withMessage('Invalid plan'),
], validate, ctrl.changePlan);

// ── Users ──────────────────────────────────────────────────────────────────
router.get('/users', ctrl.getUsers);

// ── Broadcast ──────────────────────────────────────────────────────────────
router.post('/broadcast', [
  body('subject').trim().notEmpty().withMessage('Subject is required'),
  body('message').trim().notEmpty().withMessage('Message is required'),
], validate, ctrl.broadcast);

// ── Email diagnostics (super-admin only, per the router.use guard above) ───
router.post('/test-email', async (req, res) => {
  try {
    const { sendEmail } = require('../services/emailService');
    await sendEmail({
      to: req.body.to || 'henryengrakpan@gmail.com',
      subject: 'BizlyAI Email Test',
      html: '<h1>Email is working!</h1><p>Sent at: ' + new Date() + '</p>',
    });
    res.json({ success: true, message: 'Email sent!' });
  } catch (err) {
    res.json({ success: false, error: err.message, code: err.code });
  }
});

module.exports = router;
