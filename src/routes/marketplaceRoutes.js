'use strict';

// PUBLIC — the central cross-tenant marketplace directory. No slug scoping
// here (unlike storefrontRoutes) since this deliberately spans every store.
const express = require('express');
const { publicStoreLimiter } = require('../middleware/rateLimitMiddleware');
const ctrl = require('../controllers/marketplaceController');

const router = express.Router();
router.use(publicStoreLimiter);

router.get('/featured', ctrl.getFeaturedStores);
router.get('/search', ctrl.searchMarketplace);
router.get('/categories', ctrl.getMarketplaceCategories);
router.get('/stats', ctrl.getMarketplaceStats);
router.get('/trending', ctrl.getTrendingProducts);
router.get('/stores', ctrl.getMarketplace);
router.get('/', ctrl.getMarketplace);

module.exports = router;
