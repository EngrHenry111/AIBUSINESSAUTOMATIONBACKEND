'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/invoiceController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/', ctrl.getInvoices);
router.post('/', ctrl.createInvoice);
router.get('/overdue', ctrl.getOverdueInvoices);
router.get('/:id', ctrl.getInvoice);
router.put('/:id', ctrl.updateInvoice);
router.delete('/:id', ctrl.deleteInvoice);
router.post('/:id/draft-reminder', aiLimiter, ctrl.draftReminder);
router.post('/:id/send-email', ctrl.sendInvoiceEmail);
router.post('/:id/send-receipt', ctrl.sendPaymentReceipt);

router.get('/:id/pdf', protect, enforceTenant, ctrl.generatePDF);

module.exports = router;
