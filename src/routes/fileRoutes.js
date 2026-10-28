'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/fileController');
const router = express.Router();

router.use(protect, enforceTenant);
router.get('/link', ctrl.getFileLink);

module.exports = router;
