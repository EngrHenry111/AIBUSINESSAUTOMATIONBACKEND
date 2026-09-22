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

// ── Storefront order backfill (super-admin only, per the router.use guard
// above) — the scheduled reconciliation job (server.js) only ever scans a
// rolling 3-hour window, so it can never recover an order paid before that
// job existed or more than 3 hours before any given run. This runs the same
// reconciliation logic against a much wider, caller-specified window for a
// one-off catch-up. `days` defaults to 30 and is capped at 180 to keep a
// single call bounded on the shared Paystack account's full transaction
// history; call it again with a different `days` value to cover more.
// May take a while for a wide window — if the HTTP response times out
// (Render's proxy has its own limit), the job keeps running server-side
// regardless; check Render's logs for the "Order reconciliation: created N
// missing order(s)" line to confirm it finished.
router.post('/reconcile-orders', async (req, res) => {
  try {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const { reconcileStorefrontOrders } = require('../utils/orderReconciliation');
    const summary = await reconcileStorefrontOrders({ from, to, maxPages: 30 });
    res.json({ success: true, window: { from, to, days }, ...summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── SMS diagnostics (super-admin only, per the router.use guard above) ────
router.post('/test-sms', async (req, res) => {
  const { sendSMS } = require('../services/smsService');
  const result = await sendSMS({
    to: req.body.phone || '08012345678',
    message: 'BizlyAI SMS test - working perfectly!',
  });
  res.json({ success: !!result, result });
});

// ── Loyalty points backfill (super-admin only, per the router.use guard
// above) — for a company that only turned loyalty ON after some of its
// orders were already delivered: those orders' delivered-status transition
// happened while LoyaltyProgram.findOne() returned nothing, so the earn
// hook skipped them by design (see orderController.awardLoyaltyForOrder).
// This re-runs that exact same function over every delivered order that
// hasn't been awarded yet, scoped to companies whose program is enabled —
// it never creates or enables a program on a company's behalf. Safe to call
// repeatedly: the Order.pointsAwarded flag makes every award idempotent.
router.post('/migrate-loyalty-points', async (req, res) => {
  try {
    const Order = require('../models/Order');
    const Company = require('../models/Company');
    const LoyaltyProgram = require('../models/LoyaltyProgram');
    const { awardLoyaltyForOrder } = require('../controllers/orderController');

    const enabledCompanyIds = (await LoyaltyProgram.find({ enabled: true }).select('companyId')).map((p) => String(p.companyId));
    if (!enabledCompanyIds.length) {
      return res.json({ success: true, ordersScanned: 0, awarded: 0, skipped: 0, message: 'No company has an enabled loyalty program.' });
    }

    const orders = await Order.find({ status: 'delivered', pointsAwarded: { $ne: true }, companyId: { $in: enabledCompanyIds } });
    const companyCache = new Map();
    let awarded = 0;
    for (const order of orders) {
      const key = String(order.companyId);
      if (!companyCache.has(key)) {
        companyCache.set(key, await Company.findById(order.companyId).select('smsSettings storeSlug companyName'));
      }
      const didAward = await awardLoyaltyForOrder(order, companyCache.get(key));
      if (didAward) awarded += 1;
    }

    console.log(`[loyalty] Migration: scanned ${orders.length} delivered order(s), awarded ${awarded}, skipped ${orders.length - awarded}`);
    res.json({ success: true, ordersScanned: orders.length, awarded, skipped: orders.length - awarded });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
