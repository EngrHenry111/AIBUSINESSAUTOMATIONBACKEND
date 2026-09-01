'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { uploadLimiter } = require('../middleware/rateLimitMiddleware');
const { uploadDocument } = require('../config/cloudinary');
const ctrl = require('../controllers/documentController');
const router = express.Router();

router.use(protect, enforceTenant);

router.get('/', ctrl.getDocuments);
router.get('/:id', ctrl.getDocument);
router.get('/:id/status', ctrl.getDocumentStatus);

// uploadDocument.single('file') parses the multipart form and puts file on req.file
router.post('/upload', uploadLimiter, uploadDocument.single('file'), ctrl.uploadDocument);
router.delete('/:id', ctrl.deleteDocument);

module.exports = router;