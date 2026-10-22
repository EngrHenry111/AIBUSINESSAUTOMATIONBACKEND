'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/groupController');
const stock = require('../controllers/groupStockController');
const credit = require('../controllers/groupCreditController');
const insights = require('../controllers/groupInsightsController');

// Multi-branch group operations. Per-branch access (owner / manager /
// department head / staff) is enforced inside the controller.
const { requireGroupPlan } = require('../utils/groupAccess');

const router = express.Router();
router.use(protect, enforceTenant);

// Plan check is open to everyone so the app can show an upgrade screen;
// every other group route needs Enterprise (or a trial).
router.get('/access', ctrl.access);
router.use(requireGroupPlan);

router.get('/me', ctrl.me);
router.get('/members', ctrl.members);
router.get('/overview', ctrl.overview);
router.post('/ai-brief', ctrl.aiBrief);
router.get('/ledger', ctrl.ledger);
router.get('/digest', ctrl.getDigest);
router.put('/digest', ctrl.updateDigest);
router.post('/digest/send-now', ctrl.sendDigestNow);
router.get('/monthly-report', ctrl.monthlyReport);
router.get('/profit', insights.profit);
router.get('/pos', insights.posList);
router.post('/pos', insights.posCreate);
router.delete('/pos/:id', insights.posDelete);

router.get('/stock', stock.list);
router.post('/stock', stock.create);
router.get('/stock/moves', stock.moves);
router.post('/stock/count', stock.count);
router.put('/stock/:id', stock.update);
router.post('/stock/:id/receive', stock.receive);
router.post('/stock/:id/adjust', stock.adjust);
router.post('/stock/:id/transfer', stock.transfer);

router.get('/credit', credit.list);
router.post('/credit', credit.create);
router.get('/credit/:id', credit.get);
router.put('/credit/:id', credit.update);
router.post('/credit/:id/payment', credit.payment);
router.post('/credit/:id/adjustment', credit.adjustment);
router.post('/credit/:id/remind', credit.remind);

router.get('/branches', ctrl.listBranches);
router.post('/branches', ctrl.createBranch);
router.put('/branches/:id', ctrl.updateBranch);
router.get('/branches/:id/last-meters', ctrl.lastMeters);
router.delete('/branches/:id', ctrl.deleteBranch);

router.get('/reports', ctrl.listReports);
router.post('/reports', ctrl.createReport);
router.post('/reports/bulk-approve', ctrl.bulkApprove);
router.get('/reports/:id', ctrl.getReport);
router.put('/reports/:id', ctrl.updateReport);
router.post('/reports/:id/submit', ctrl.submit);
router.post('/reports/:id/approve', ctrl.approve);
router.post('/reports/:id/reject', ctrl.reject);


module.exports = router;
