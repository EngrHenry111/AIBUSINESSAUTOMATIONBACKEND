'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/appointmentController');
const router = express.Router();
router.use(protect, enforceTenant);
router.get('/', ctrl.getAppointments);
router.post('/', ctrl.createAppointment);
router.get('/upcoming', ctrl.getUpcoming);
router.get('/:id', ctrl.getAppointment);
router.put('/:id', ctrl.updateAppointment);
router.delete('/:id', ctrl.deleteAppointment);

// Video call (Daily.co)
router.post('/:id/video-call', ctrl.createVideoCall);
router.get('/:id/video-call', ctrl.getVideoCall);
router.delete('/:id/video-call', ctrl.endVideoCall);

module.exports = router;
