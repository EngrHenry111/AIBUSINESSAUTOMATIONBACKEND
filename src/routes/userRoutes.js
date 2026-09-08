'use strict';
const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validateMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { isManager } = require('../middleware/roleMiddleware');
const { AppError } = require('../middleware/errorMiddleware');
const { uploadAvatar } = require('../config/cloudinary');
const ctrl = require('../controllers/userController');
const router = express.Router();

// multer avatar upload that turns its errors into a clean 400
const avatarUpload = (req, res, next) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) return next(new AppError(err.message || 'Image upload failed.', 400));
    next();
  });
};

router.use(protect, enforceTenant);
router.get('/profile', ctrl.getProfile);
router.patch('/profile', avatarUpload, ctrl.updateProfile);
router.patch('/change-password', [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 8 })], validate, ctrl.changePassword);
router.get('/team', ctrl.getTeamMembers);
router.post('/team/invite', isManager, [body('email').isEmail(), body('name').trim().notEmpty()], validate, ctrl.inviteMember);
router.patch('/team/:id/role', isManager, ctrl.updateMemberRole);
router.delete('/team/:id', isManager, ctrl.removeMember);
module.exports = router;
