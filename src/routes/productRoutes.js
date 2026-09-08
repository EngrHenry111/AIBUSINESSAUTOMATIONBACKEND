'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { uploadProductImage } = require('../config/cloudinary');
const ctrl = require('../controllers/productController');

const router = express.Router();
router.use(protect, enforceTenant);

router.get('/', ctrl.getProducts);
router.post('/', uploadProductImage.array('images', 5), ctrl.createProduct);
router.get('/categories', ctrl.getCategories);
router.get('/low-stock', ctrl.getLowStockProducts);

router.get('/:id', ctrl.getProduct);
router.put('/:id', ctrl.updateProduct);
router.delete('/:id', ctrl.deleteProduct);
router.post('/:id/images', uploadProductImage.array('images', 5), ctrl.uploadImages);
router.post('/:id/stock', ctrl.adjustStock);
router.get('/:id/stock-history', ctrl.getStockHistory);

module.exports = router;
