'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isEmployee, isManager } = require('../middleware/roleMiddleware');
const { uploadProductImage } = require('../config/cloudinary');
const { uploadLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/cleaningController');

// Cleaning services. Managers book, schedule, price and cancel; cleaners
// see their own jobs and work them (status, checklist, photos, payment).
const router = express.Router();
router.use(protect, enforceTenant, isEmployee);

router.get('/settings', ctrl.getSettings);
router.put('/settings', isManager, ctrl.updateSettings);
router.get('/team', isManager, ctrl.getTeam);
router.get('/jobs', ctrl.listJobs);
router.post('/jobs', isManager, ctrl.createJob);
router.get('/jobs/:id', ctrl.getJob);
router.put('/jobs/:id', isManager, ctrl.updateJob);
router.post('/jobs/:id/status', ctrl.setStatus);
router.post('/jobs/:id/checklist/:index', ctrl.toggleTask);
router.post('/jobs/:id/photos', uploadLimiter, uploadProductImage.array('photos', 10), ctrl.addPhotos);
router.post('/jobs/:id/payments', ctrl.addPayment);
router.post('/jobs/:id/cancel', isManager, ctrl.cancelJob);

module.exports = router;
