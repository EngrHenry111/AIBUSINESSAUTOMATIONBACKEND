'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/contractController');

const router = express.Router();
router.use(protect, enforceTenant);

// Generating and sending a contract commits the company to real legal
// obligations, so those two are restricted to managers and above — an
// employee can still view, edit a draft, download or duplicate.
router.post('/generate', aiLimiter, isManager, ctrl.generateContract);
router.get('/', ctrl.getContracts);
router.get('/:id', ctrl.getContract);
router.put('/:id', ctrl.updateContract);
router.delete('/:id', ctrl.deleteContract);
router.post('/:id/send', isManager, ctrl.sendContract);
router.get('/:id/pdf', ctrl.generatePDF);
router.post('/:id/duplicate', ctrl.duplicateContract);
router.patch('/:id/sign', ctrl.markSigned);

module.exports = router;
