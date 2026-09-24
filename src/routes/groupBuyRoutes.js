'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/groupBuyController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getGroupBuys);
router.post('/', isManager, ctrl.createGroupBuy);
router.delete('/:id', isManager, ctrl.cancelGroupBuy);

module.exports = router;
