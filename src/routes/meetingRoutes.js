'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/meetingController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/', ctrl.getMeetings);
router.post('/', ctrl.createMeeting);
router.get('/:id', ctrl.getMeeting);
router.put('/:id', ctrl.updateMeeting);
router.delete('/:id', ctrl.deleteMeeting);
router.post('/:id/summarize', aiLimiter, ctrl.summarizeMeeting);

module.exports = router;
