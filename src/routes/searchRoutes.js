'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { globalSearch } = require('../controllers/searchController');
const router = express.Router();
router.use(protect, enforceTenant);
router.get('/', globalSearch);
module.exports = router;
