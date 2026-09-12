'use strict';
const express = require('express');
const timeout = require('connect-timeout');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/invoiceController');
const router = express.Router();

router.use(protect, enforceTenant);
// Safety net for any slow path in this router (AI drafting, PDF render) — the
// email-sending routes no longer need this themselves since they respond
// before the email is even sent, but this still bounds everything else.
router.use(timeout('30s'));

router.get('/', ctrl.getInvoices);
router.post('/', ctrl.createInvoice);
router.get('/overdue', ctrl.getOverdueInvoices);
router.get('/:id', ctrl.getInvoice);
router.put('/:id', ctrl.updateInvoice);
router.delete('/:id', ctrl.deleteInvoice);
router.post('/:id/draft-reminder', aiLimiter, ctrl.draftReminder);
router.post('/:id/send-email', ctrl.sendInvoiceEmail);
router.post('/:id/send-receipt', ctrl.sendPaymentReceipt);

router.get('/:id/pdf', ctrl.generatePDF);

module.exports = router;
