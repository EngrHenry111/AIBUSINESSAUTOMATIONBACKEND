'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const { uploadProductImage } = require('../config/cloudinary');
const ctrl = require('../controllers/companyController');
const router = express.Router();
router.use(protect, enforceTenant);
router.get('/', ctrl.getCompany);
router.patch('/', isManager, ctrl.updateCompany);
router.get('/usage', ctrl.getUsage);
router.patch('/ai-settings', isManager, ctrl.updateAISettings);

// Storefront management
router.get('/store', ctrl.getStoreSettings);
router.put('/store', isManager, ctrl.updateStoreSettings);
router.post('/store/banner', isManager, uploadProductImage.single('banner'), ctrl.uploadStoreBanner);
router.get('/store/analytics', ctrl.getStoreAnalytics);

module.exports = router;
