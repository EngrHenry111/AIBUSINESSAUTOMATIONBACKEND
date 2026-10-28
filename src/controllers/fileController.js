'use strict';

const Document = require('../models/Document');
const { AppError } = require('../middleware/errorMiddleware');
const { parsePrivateUrl, signedLink } = require('../utils/privateFiles');
const { documentFilterFor } = require('../utils/documentAccess');

// ── GET /files/link?u=<stored file url> ──────────────────────────────────
// A 5-minute link to one of this company's private files.
exports.getFileLink = async (req, res, next) => {
  try {
    const parsed = parsePrivateUrl(req.query.u);
    // Every private upload lives under business-ai/<companyId>/…
    if (!parsed || !parsed.publicId.startsWith(`business-ai/${req.companyId}/`)) {
      return next(new AppError('File not found.', 404));
    }
    if (parsed.publicId.startsWith(`business-ai/${req.companyId}/documents/`)) {
      const allowed = await Document.exists({ companyId: req.companyId, cloudinaryPublicId: parsed.publicId, ...documentFilterFor(req.user) });
      if (!allowed) return next(new AppError('File not found.', 404));
    }
    const url = signedLink(req.query.u);
    if (!url) return next(new AppError('File storage is not available.', 503));
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, url });
  } catch (err) { next(err); }
};
