'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/contractController');

const router = express.Router();
router.use(protect, enforceTenant);

router.post('/generate', aiLimiter, ctrl.generateContract);
router.get('/', ctrl.getContracts);
router.get('/:id', ctrl.getContract);
router.put('/:id', ctrl.updateContract);
router.delete('/:id', ctrl.deleteContract);
router.post('/:id/send', ctrl.sendContract);
router.get('/:id/pdf', ctrl.generatePDF);
router.post('/:id/duplicate', ctrl.duplicateContract);

module.exports = router;
