'use strict';

// PUBLIC storefront — no auth. Customers shop and pay without a BizlyAI
// account. Every route here is addressed by :slug only — never companyId —
// so a company's internal database ID is never something a shopper needs
// to know or can discover from this API. See storefrontController's
// publicStore()/publicProduct() for the response-side half of that guarantee.
const express = require('express');
const { publicStoreLimiter } = require('../middleware/rateLimitMiddleware');
const { uploadReceipt } = require('../config/cloudinary');
const ctrl = require('../controllers/storefrontController');

const router = express.Router();
router.use(publicStoreLimiter);

router.get('/:slug', ctrl.getStore);
router.get('/:slug/products', ctrl.getStoreProducts);
router.get('/:slug/products/:id', ctrl.getStoreProduct);
router.post('/:slug/products/:id/review', ctrl.addProductReview);
router.get('/:slug/categories', ctrl.getStoreCategories);
router.get('/:slug/loyalty', ctrl.getStoreLoyaltyStatus);
router.post('/:slug/coupon/validate', ctrl.validateCoupon);
router.get('/:slug/track/:orderNumber', ctrl.trackOrder);
router.post('/:slug/orders/:id/bank-proof', uploadReceipt.single('proof'), ctrl.uploadBankProof);
router.post('/:slug/checkout', ctrl.initializeStorePayment);
router.get('/:slug/verify/:reference', ctrl.verifyStorePayment);

module.exports = router;
