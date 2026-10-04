'use strict';

// Legal practice management — matters, time & disbursements, key dates,
// client trust ledger, conflict checks and matter billing.
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/matterController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getMatters);
router.post('/', ctrl.createMatter);
router.post('/conflict-check', ctrl.conflictCheck);
router.get('/calendar', ctrl.getCalendar);
router.get('/reports/utilization', ctrl.getUtilization);
router.put('/entries/:entryId', ctrl.updateEntry);
router.delete('/entries/:entryId', ctrl.deleteEntry);

router.get('/:id', ctrl.getMatter);
router.put('/:id', ctrl.updateMatter);
router.delete('/:id', ctrl.deleteMatter);
router.get('/:id/entries', ctrl.getEntries);
router.post('/:id/entries', ctrl.createEntry);
router.post('/:id/key-dates', ctrl.addKeyDate);
router.put('/:id/key-dates/:dateId', ctrl.updateKeyDate);
router.delete('/:id/key-dates/:dateId', ctrl.deleteKeyDate);
router.get('/:id/trust', ctrl.getTrust);
router.post('/:id/trust', ctrl.createTrustTransaction);
router.post('/:id/invoice', ctrl.invoiceMatter);

module.exports = router;
