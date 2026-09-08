'use strict';

const fs = require('fs');
const User = require('../models/User');
const Company = require('../models/Company');
const { cloudinary } = require('../config/cloudinary');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');

const safeJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).populate('companyId', 'companyName industry logo');
    res.status(200).json({ success: true, data: user });
  } catch (err) { next(err); }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.preferences !== undefined) {
      updates.preferences = typeof req.body.preferences === 'string'
        ? safeJson(req.body.preferences)
        : req.body.preferences;
    }

    // Avatar upload — Cloudinary when configured, local static fallback otherwise
    if (req.file) {
      let avatarUrl = null;
      if (cloudinary) {
        try {
          const result = await cloudinary.uploader.upload(req.file.path, {
            folder: 'business-ai/avatars',
            resource_type: 'image',
            transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
          });
          avatarUrl = result.secure_url;
          fs.unlink(req.file.path, () => {});
        } catch (e) {
          logger.warn(`Avatar Cloudinary upload failed: ${e.message}`);
        }
      }
      if (!avatarUrl) {
        const base = (process.env.API_URL || '').replace(/\/+$/, '');
        avatarUrl = `${base}/uploads/avatars/${req.file.filename}`;
      }
      updates.avatar = avatarUrl;
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.profile_update', ip: req.ip });
    res.status(200).json({ success: true, data: user });
  } catch (err) { next(err); }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      return next(new AppError('Current password is incorrect.', 401));
    }
    user.password = newPassword;
    await user.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.password_change', ip: req.ip });
    res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (err) { next(err); }
};

exports.getTeamMembers = async (req, res, next) => {
  try {
    const members = await User.find({ companyId: req.companyId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: members });
  } catch (err) { next(err); }
};

exports.inviteMember = async (req, res, next) => {
  try {
    const { email, name, role = 'employee' } = req.body;
    const company = await Company.findById(req.companyId).select('limits');
    const currentCount = await User.countDocuments({ companyId: req.companyId, status: 'active' });

    if (currentCount >= company.limits.maxUsers) {
      return next(new AppError(`User limit reached (${company.limits.maxUsers}). Upgrade your plan to add more members.`, 403));
    }

    const existing = await User.findOne({ email });
    if (existing) return next(new AppError('Email already registered.', 409));

    const tempPassword = Math.random().toString(36).slice(-12) + 'A1!';
    const user = await User.create({
      name, email,
      password: tempPassword,
      role,
      companyId: req.companyId,
      status: 'active',
    });

    logger.info(`Team member invited: ${email} with temp password: ${tempPassword}`);
    // TODO: Send invitation email with tempPassword

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'user.invite', resource: 'User', resourceId: user._id,
      description: `Invited ${email} as ${role}`, ip: req.ip,
    });

    res.status(201).json({ success: true, data: user, message: 'Team member invited. They will receive login credentials.' });
  } catch (err) { next(err); }
};

exports.updateMemberRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    if (req.params.id === req.user._id.toString()) return next(new AppError('Cannot change your own role.', 400));

    const member = await User.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { role }, { new: true }
    );
    if (!member) return next(new AppError('Team member not found.', 404));

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.role_change', resource: 'User', resourceId: req.params.id, metadata: { newRole: role }, ip: req.ip });
    res.status(200).json({ success: true, data: member });
  } catch (err) { next(err); }
};

exports.removeMember = async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) return next(new AppError('Cannot remove yourself.', 400));

    const member = await User.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { status: 'inactive' }, { new: true }
    );
    if (!member) return next(new AppError('Team member not found.', 404));

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.remove', resource: 'User', resourceId: req.params.id, ip: req.ip });
    res.status(200).json({ success: true, message: 'Team member removed.' });
  } catch (err) { next(err); }
};
