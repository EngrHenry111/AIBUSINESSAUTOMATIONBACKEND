'use strict';

// PUBLIC — crawler-facing endpoints. The frontend host rewrites /sitemap.xml
// here (see frontend/vercel.json) so the sitemap lists every live store.
const express = require('express');
const ctrl = require('../controllers/seoController');

const router = express.Router();
router.get('/sitemap.xml', ctrl.getSitemap);

module.exports = router;
