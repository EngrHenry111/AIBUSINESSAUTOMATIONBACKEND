'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/inboxController');

const router = express.Router();

router.use(protect, enforceTenant);

router.get('/conversations', ctrl.getConversations);
router.get('/unclaimed-count', ctrl.getUnclaimedCount);
router.get('/conversations/:id', ctrl.getConversation);
router.post('/conversations/:id/reply', ctrl.reply);
router.post('/conversations/:id/takeover', ctrl.takeover);
router.post('/conversations/:id/resolve', ctrl.resolve);
router.post('/conversations/:id/send-to-ai', ctrl.backToAI);
router.patch('/contacts/:id/notes', ctrl.updateContactNotes);

module.exports = router;
