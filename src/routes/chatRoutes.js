'use strict';
const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validateMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/chatController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/', ctrl.getChats);
router.post('/', ctrl.createChat);
router.get('/:id', ctrl.getChat);
router.patch('/:id', ctrl.updateChat);
router.delete('/:id', ctrl.deleteChat);
router.post('/ask', aiLimiter, [
  body('question').trim().notEmpty().withMessage('Question is required'),
], validate, ctrl.askQuestion);
router.patch('/:id/feedback', ctrl.addFeedback);

module.exports = router;
