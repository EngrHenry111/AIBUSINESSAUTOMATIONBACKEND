'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const ctrl = require('../controllers/messageController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/conversations', ctrl.getTeamConversations);
router.get('/unread-count', ctrl.getUnreadCount);
router.get('/:userId', ctrl.getConversation);
router.post('/:userId', ctrl.sendMessage);
router.delete('/:messageId', ctrl.deleteMessage);

module.exports = router;
