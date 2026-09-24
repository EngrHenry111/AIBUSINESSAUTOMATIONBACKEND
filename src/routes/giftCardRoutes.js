'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/giftCardController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getStoreGiftCards);

module.exports = router;
