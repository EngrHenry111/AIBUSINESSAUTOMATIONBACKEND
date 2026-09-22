'use strict';

// PUBLIC storefront — no auth. Customers shop and pay without a BizlyAI
// account. Every route here is addressed by :slug only — never companyId —
// so a company's internal database ID is never something a shopper needs
// to know or can discover from this API. See storefrontController's
// publicStore()/publicProduct() for the response-side half of that guarantee.
const express = require('express');
const { publicStoreLimiter, authLimiter } = require('../middleware/rateLimitMiddleware');
const { uploadReceipt } = require('../config/cloudinary');
const { loadStore, authenticateStoreCustomer } = require('../middleware/storeCustomerAuth');
const ctrl = require('../controllers/storefrontController');
const customerCtrl = require('../controllers/storeCustomerController');

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
router.post('/:slug/orders/:orderNumber/bank-proof', uploadReceipt.single('proof'), ctrl.uploadBankProof);
router.post('/:slug/checkout', ctrl.initializeStorePayment);
router.get('/:slug/verify/:reference', ctrl.verifyStorePayment);

// ── Store customer accounts — separate from the main BizlyAI login ───────
router.post('/:slug/customer/register', authLimiter, loadStore, customerCtrl.registerStoreCustomer);
router.post('/:slug/customer/login', authLimiter, loadStore, customerCtrl.loginStoreCustomer);
router.get('/:slug/customer/me', loadStore, authenticateStoreCustomer, customerCtrl.getStoreCustomer);
router.patch('/:slug/customer/me', loadStore, authenticateStoreCustomer, customerCtrl.updateStoreCustomer);
router.put('/:slug/customer/addresses', loadStore, authenticateStoreCustomer, customerCtrl.updateStoreCustomerAddresses);
router.get('/:slug/customer/orders', loadStore, authenticateStoreCustomer, customerCtrl.getCustomerOrders);
router.get('/:slug/customer/wishlist', loadStore, authenticateStoreCustomer, customerCtrl.getWishlist);
router.post('/:slug/customer/wishlist/sync', loadStore, authenticateStoreCustomer, customerCtrl.syncWishlist);
router.post('/:slug/customer/wishlist/:productId', loadStore, authenticateStoreCustomer, customerCtrl.addToWishlist);
router.delete('/:slug/customer/wishlist/:productId', loadStore, authenticateStoreCustomer, customerCtrl.removeFromWishlist);

module.exports = router;
