'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const { uploadMeetingFile } = require('../config/cloudinary');
const ctrl = require('../controllers/meetingController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/', ctrl.getMeetings);
router.post('/', ctrl.createMeeting);
router.get('/:id', ctrl.getMeeting);
router.put('/:id', ctrl.updateMeeting);
router.delete('/:id', ctrl.deleteMeeting);
router.post('/:id/summarize', aiLimiter, ctrl.summarizeMeeting);
router.get('/:id/pdf', ctrl.exportPDF);

// Agenda builder
router.post('/:id/agenda', ctrl.addAgendaItem);
router.put('/:id/agenda/:itemId', ctrl.updateAgendaItem);
router.delete('/:id/agenda/:itemId', ctrl.deleteAgendaItem);

// Attendance
router.put('/:id/attendance', ctrl.recordAttendance);

// Resolutions / motions
router.post('/:id/resolutions', ctrl.addResolution);
router.put('/:id/resolutions/:resolutionId', ctrl.updateResolution);
router.delete('/:id/resolutions/:resolutionId', ctrl.deleteResolution);

// Action items
router.post('/:id/action-items', ctrl.addActionItem);
router.put('/:id/action-items/:itemId', ctrl.updateActionItem);
router.delete('/:id/action-items/:itemId', ctrl.deleteActionItem);

// Minutes
router.put('/:id/minutes', ctrl.saveMinutes);
router.post('/:id/minutes/generate', aiLimiter, ctrl.generateMinutesFromNotes);
router.put('/:id/confirm-previous', ctrl.confirmPreviousMinutes);

// Attachments
router.post('/:id/attachments', uploadMeetingFile.single('file'), ctrl.uploadAttachment);
router.delete('/:id/attachments/:attachmentId', ctrl.deleteAttachment);

module.exports = router;
