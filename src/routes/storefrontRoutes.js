'use strict';

// PUBLIC storefront — no auth. Customers shop and pay without a BizlyAI account.
const express = require('express');
const ctrl = require('../controllers/storefrontController');

const router = express.Router();

router.get('/:slug', ctrl.getStore);
router.get('/:slug/products', ctrl.getStoreProducts);
router.get('/:slug/categories', ctrl.getStoreCategories);
router.post('/:slug/checkout', ctrl.initializeStorePayment);
router.get('/:slug/verify/:reference', ctrl.verifyStorePayment);

module.exports = router;
