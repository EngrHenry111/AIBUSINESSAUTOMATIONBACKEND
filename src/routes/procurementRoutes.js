'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const { uploadDocument } = require('../config/cloudinary');
const { AppError } = require('../middleware/errorMiddleware');
const ctrl = require('../controllers/procurementController');

const router = express.Router();
router.use(protect, enforceTenant, isManager);

// e-Procurement is a Business-plan feature — gated server-side (not just a
// hidden sidebar link) since the frontend alone can't stop a direct API call.
const requireBusinessPlan = (req, res, next) => {
  if (req.company?.subscription?.plan !== 'business' && req.user.role !== 'super_admin') {
    return next(new AppError('e-Procurement is available on the Business plan. Please upgrade to access this feature.', 403));
  }
  next();
};
router.use(requireBusinessPlan);

router.post('/', ctrl.createRequisition);
router.get('/', ctrl.getRequisitions);
router.get('/reports', ctrl.generateReport);
router.get('/budgets', ctrl.getBudgets);
router.post('/budgets', ctrl.createBudget);
router.get('/vendors', ctrl.getVendors);
router.post('/vendors', ctrl.createVendor);
router.get('/:id', ctrl.getRequisition);
router.put('/:id', ctrl.updateRequisition);
router.post('/:id/approve', ctrl.approveRequisition);
router.post('/:id/reject', ctrl.rejectRequisition);
router.post('/:id/vendors', uploadDocument.single('quotationDocument'), ctrl.addVendorQuotation);
router.post('/:id/select-vendor', ctrl.selectVendor);
router.get('/:id/purchase-order', ctrl.generatePO);
router.patch('/:id/delivered', ctrl.markDelivered);

module.exports = router;
