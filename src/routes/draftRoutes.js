'use strict';

const express = require('express');
const multer = require('multer');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { AppError } = require('../middleware/errorMiddleware');
const ctrl = require('../controllers/draftController');

const router = express.Router();

// Attachments stay in memory — they're forwarded straight to the email
// provider and never stored. 5 files × 8MB keeps the base64-encoded message
// well under Resend's 40MB cap.
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|js|vbs|ps1|jar|sh|apk)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (BLOCKED_EXT.test(file.originalname)) cb(new Error('That file type cannot be attached.'));
    else cb(null, true);
  },
});
const attachments = (req, res, next) => upload.array('files', 5)(req, res, (err) => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each attachment must be 8MB or smaller.'
    : err.code === 'LIMIT_FILE_COUNT' ? 'Attach up to 5 files.' : err.message;
  next(new AppError(msg, 400));
});

router.use(protect, enforceTenant);
router.put('/:type/:id', ctrl.saveDraft);
router.post('/:type/:id/send', attachments, ctrl.sendDraft);

module.exports = router;
