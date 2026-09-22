'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/couponController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getCoupons);
router.post('/', isManager, ctrl.createCoupon);
router.put('/:id', isManager, ctrl.updateCoupon);
router.delete('/:id', isManager, ctrl.deleteCoupon);

module.exports = router;
