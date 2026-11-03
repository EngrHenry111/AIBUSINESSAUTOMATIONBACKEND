'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const { isEmployee } = require('../middleware/roleMiddleware');
const ctrl = require('../controllers/assistantController');
const router = express.Router();

router.use(protect, enforceTenant, isEmployee);

router.post('/chat', aiLimiter, ctrl.chat);
router.get('/conversations', ctrl.listConversations);
router.get('/conversations/:id', ctrl.getConversation);
router.delete('/conversations/:id', ctrl.deleteConversation);
router.post('/conversations/:id/actions/:actionId/approve', ctrl.approveAction);
router.post('/conversations/:id/actions/:actionId/reject', ctrl.rejectAction);

module.exports = router;
