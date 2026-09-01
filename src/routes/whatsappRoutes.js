// 'use strict';

// const express = require('express');
// const { protect } = require('../middleware/authMiddleware');
// const { requireRole } = require('../middleware/roleMiddleware');
// const ctrl = require('../controllers/whatsappController');
// const router = express.Router();

// router.use(protect);

// router.get('/status', ctrl.getStatus);
// router.post('/initialize', requireRole('company_owner', 'manager'), ctrl.initialize);
// router.post('/disconnect', requireRole('company_owner', 'manager'), ctrl.disconnect);
// router.post('/send-test', requireRole('company_owner', 'manager'), ctrl.sendTest);

// module.exports = router;