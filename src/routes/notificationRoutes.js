'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { getNotifications } = require('../controllers/notificationController');
const router = express.Router();
router.use(protect, enforceTenant);
router.get('/', getNotifications);
module.exports = router;
