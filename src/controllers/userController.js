'use strict';

const fs = require('fs');
const crypto = require('crypto');
const User = require('../models/User');
const Company = require('../models/Company');
const { cloudinary } = require('../config/cloudinary');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const securityLogger = require('../utils/securityLogger');
const { generateAccessToken, generateRefreshToken, generateResetToken, setTokenCookies } = require('../utils/generateTokens');
const logger = require('../utils/logger');
const emailService = require('../services/emailService');
const { DEFAULT_DEPARTMENTS } = require('../utils/departments');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

// Roles assignable by a human via invite/role-change — never 'company_owner'
// (there is exactly one per company, set at signup — no transfer-of-
// ownership flow exists here) or 'super_admin' (a platform-level role, not a
// tenant one) or 'customer' (that's what StoreCustomer is for).
const ASSIGNABLE_ROLES = ['manager', 'employee'];

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
    if (req.body.phone !== undefined) updates.phone = req.body.phone;
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
    const user = await User.findById(req.user._id).select('+password +refreshToken');
    if (!(await user.comparePassword(currentPassword))) {
      return next(new AppError('Current password is incorrect.', 401));
    }
    user.password = newPassword;
    // Invalidate every previously-issued token (all other devices are forced
    // to sign in again) — then immediately issue this device a fresh pair so
    // its own session isn't the one that gets kicked out.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    const accessToken = generateAccessToken(user._id, user.tokenVersion);
    const refreshToken = generateRefreshToken(user._id, user.tokenVersion);
    user.refreshToken = refreshToken;
    await user.save();

    setTokenCookies(res, accessToken, refreshToken);
    securityLogger.logPasswordChange(req.user._id, user.email, req.ip);
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
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return next(new AppError('Invalid role. Team members can be invited as manager or employee.', 400));
    }
    // Only the owner can bring in another manager — a manager inviting a
    // peer manager (or worse, repeatedly promoting invitees) is how one
    // compromised manager account used to be able to take over a whole
    // company's team. Employee-level invites stay open to any manager+.
    if (role === 'manager' && req.user.role !== 'company_owner' && req.user.role !== 'super_admin') {
      return next(new AppError('Only the company owner can invite someone as a manager.', 403));
    }

    const company = await Company.findById(req.companyId).select('limits companyName');
    const currentCount = await User.countDocuments({ companyId: req.companyId, status: 'active' });

    // maxUsers of -1 means unlimited (Enterprise) — without this guard a
    // negative limit would make currentCount >= maxUsers true immediately
    // and block every single invite.
    if (company.limits.maxUsers > 0 && currentCount >= company.limits.maxUsers) {
      return next(new AppError(`User limit reached (${company.limits.maxUsers}). Upgrade your plan to add more members.`, 403));
    }

    const existing = await User.findOne({ email });
    if (existing) return next(new AppError('Email already registered.', 409));

    // A random password the invitee will never see or need — they set their
    // own via the emailed link below (same passwordResetToken mechanism as
    // forgotPassword, just a longer window since this is a first-time setup
    // rather than an urgent reset).
    const placeholderPassword = crypto.randomBytes(24).toString('hex');
    const { token, hash } = generateResetToken();
    const user = await User.create({
      name, email,
      password: placeholderPassword,
      role,
      companyId: req.companyId,
      status: 'active',
      passwordResetToken: hash,
      passwordResetExpires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    const setupLink = `${clientUrl()}/reset-password/${token}`;
    logger.info(`Team member invited: ${email} — setup link logged in case email delivery fails: ${setupLink}`);
    emailService.sendTeamInvite(email, name, req.user.name, company.companyName, setupLink, role).then(() => {
      logger.info(`✅ Invite email sent to ${email}`);
    }).catch((err) => {
      logger.warn(`⚠️  Invite email failed (${err.message}) — setup link logged above, share it manually if needed`);
    });

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'user.invite', resource: 'User', resourceId: user._id,
      description: `Invited ${email} as ${role}`, ip: req.ip,
    });

    res.status(201).json({ success: true, data: user, message: 'Team member invited. They will receive an email to set up their account.' });
  } catch (err) { next(err); }
};

exports.updateMemberRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return next(new AppError('Invalid role. Team members can only be set to manager or employee.', 400));
    }
    if (req.params.id === req.user._id.toString()) return next(new AppError('Cannot change your own role.', 400));

    const target = await User.findOne({ _id: req.params.id, companyId: req.companyId }).select('role');
    if (!target) return next(new AppError('Team member not found.', 404));
    // Not just company_owner — a company's "owner" account can also be
    // flagged super_admin (platform staff running the company), and that
    // must be at least as protected, not less.
    if (!ASSIGNABLE_ROLES.includes(target.role)) return next(new AppError('This member\'s role cannot be changed here.', 400));

    const member = await User.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { role }, { new: true }
    );

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.role_change', resource: 'User', resourceId: req.params.id, metadata: { newRole: role }, ip: req.ip });
    res.status(200).json({ success: true, data: member });
  } catch (err) { next(err); }
};

// ── PATCH /users/team/:id/department (manager+) ─────────────────────────────
// Assigning an EXISTING department is organizational, not a security
// boundary, so any manager can do it — creating a new custom department name
// is the owner-only action (see companyController.addDepartment).
exports.updateMemberDepartment = async (req, res, next) => {
  try {
    const { department } = req.body;
    const company = await Company.findById(req.companyId).select('departments');
    const valid = [...DEFAULT_DEPARTMENTS, ...(company.departments || [])];

    if (department !== null && department !== '' && !valid.includes(department)) {
      return next(new AppError('That department does not exist for this company.', 400));
    }

    const member = await User.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { department: department || null }, { new: true }
    );
    if (!member) return next(new AppError('Team member not found.', 404));

    res.status(200).json({ success: true, data: member });
  } catch (err) { next(err); }
};

exports.removeMember = async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) return next(new AppError('Cannot remove yourself.', 400));

    const target = await User.findOne({ _id: req.params.id, companyId: req.companyId }).select('role');
    if (!target) return next(new AppError('Team member not found.', 404));
    // Same reasoning as updateMemberRole — the owner account can also be
    // flagged super_admin, so this checks "not a manager/employee" rather
    // than the single literal 'company_owner' string.
    if (!ASSIGNABLE_ROLES.includes(target.role)) return next(new AppError('This member cannot be removed.', 400));

    const member = await User.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { status: 'inactive' }, { new: true }
    );

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.remove', resource: 'User', resourceId: req.params.id, ip: req.ip });
    res.status(200).json({ success: true, message: 'Team member removed.' });
  } catch (err) { next(err); }
};
