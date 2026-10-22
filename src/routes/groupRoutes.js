'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/groupController');

// Multi-branch group operations. Per-branch access (owner / manager /
// department head / staff) is enforced inside the controller.
const router = express.Router();
router.use(protect, enforceTenant);

router.get('/me', ctrl.me);
router.get('/members', ctrl.members);
router.get('/overview', ctrl.overview);
router.post('/ai-brief', ctrl.aiBrief);
router.get('/ledger', ctrl.ledger);
router.get('/digest', ctrl.getDigest);
router.put('/digest', ctrl.updateDigest);
router.post('/digest/send-now', ctrl.sendDigestNow);

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
