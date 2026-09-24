'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager, isCompanyOwner } = require('../middleware/roleMiddleware');
const { uploadProductImage } = require('../config/cloudinary');
const ctrl = require('../controllers/companyController');
const router = express.Router();
router.use(protect, enforceTenant);
router.get('/', ctrl.getCompany);
router.patch('/', isManager, uploadProductImage.single('logo'), ctrl.updateCompany);
router.get('/usage', ctrl.getUsage);
router.patch('/ai-settings', isManager, ctrl.updateAISettings);
router.patch('/sms-settings', isManager, ctrl.updateSMSSettings);
router.post('/test-sms', isManager, ctrl.testSMS);

// Departments — standard list is free; adding/removing a custom one is
// owner-only (see companyController for why).
router.get('/departments', ctrl.getDepartments);
router.post('/departments', isCompanyOwner, ctrl.addDepartment);
router.delete('/departments/:name', isCompanyOwner, ctrl.deleteDepartment);

// Storefront management
router.get('/store', ctrl.getStoreSettings);
router.put('/store', isManager, ctrl.updateStoreSettings);
router.post('/store/banner', isManager, uploadProductImage.single('banner'), ctrl.uploadStoreBanner);
router.get('/store/analytics', ctrl.getStoreAnalytics);

module.exports = router;
