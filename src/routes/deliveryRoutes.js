'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/deliveryController');

const router = express.Router();

// ── Public — no auth, no tenant scoping (see controller comments) ──────────
router.get('/track/:trackingNumber', ctrl.trackShipment);
router.post('/webhook/gig', ctrl.gigWebhook);
router.post('/webhook/kwik', ctrl.kwikWebhook);
router.post('/webhook/sendbox', ctrl.sendboxWebhook);

// ── Protected (store owner/manager) ─────────────────────────────────────────
router.use(protect, enforceTenant);
router.get('/providers', ctrl.getProviders);
router.post('/providers/:provider/connect', isManager, ctrl.connectProvider);
router.delete('/providers/:provider/connect', isManager, ctrl.disconnectProvider);
router.post('/providers/:provider/test', isManager, ctrl.testConnection);
router.post('/quote', isManager, ctrl.getQuote);
router.post('/shipments', isManager, ctrl.createShipment);
router.get('/shipments', ctrl.getShipments);
router.patch('/shipments/:id/status', isManager, ctrl.updateShipmentStatus);

module.exports = router;
