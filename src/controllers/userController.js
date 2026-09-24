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

// A manager may only bring in an employee; only the owner (or super_admin)
// can bring in another manager — shared by inviteMember and bulkInviteMembers
// so both enforce the exact same rule.
function canInviteAs(inviterRole, role) {
  if (!ASSIGNABLE_ROLES.includes(role)) return { message: 'Invalid role. Team members can be invited as manager or employee.', statusCode: 400 };
  if (role === 'manager' && inviterRole !== 'company_owner' && inviterRole !== 'super_admin') {
    return { message: 'Only the company owner can invite someone as a manager.', statusCode: 403 };
  }
  return null;
}

// Shared by inviteMember and bulkInviteMembers — creates the user with a
// passwordResetToken-based setup link (see inviteMember's own comment for
// why) and fires the invite email. Throws an AppError-shaped {message,
// statusCode} on validation failure rather than calling next() itself, so
// callers can decide how to report a single failure within a batch.
async function createInvitedUser({ companyId, name, email, role, inviter, companyName }) {
  const existing = await User.findOne({ email });
  if (existing) { const e = new Error('Email already registered.'); e.statusCode = 409; throw e; }

  const placeholderPassword = crypto.randomBytes(24).toString('hex');
  const { token, hash } = generateResetToken();
  const user = await User.create({
    name, email, password: placeholderPassword, role, companyId, status: 'active',
    passwordResetToken: hash,
    passwordResetExpires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  const setupLink = `${clientUrl()}/reset-password/${token}`;
  logger.info(`Team member invited: ${email} — setup link logged in case email delivery fails: ${setupLink}`);
  emailService.sendTeamInvite(email, name, inviter.name, companyName, setupLink, role).then(() => {
    logger.info(`✅ Invite email sent to ${email}`);
  }).catch((err) => {
    logger.warn(`⚠️  Invite email failed (${err.message}) — setup link logged above, share it manually if needed`);
  });

  return user;
}

exports.inviteMember = async (req, res, next) => {
  try {
    const { email, name, role = 'employee' } = req.body;
    const roleError = canInviteAs(req.user.role, role);
    if (roleError) return next(new AppError(roleError.message, roleError.statusCode));

    const company = await Company.findById(req.companyId).select('limits companyName');
    const currentCount = await User.countDocuments({ companyId: req.companyId, status: 'active' });

    // maxUsers of -1 means unlimited (Enterprise) — without this guard a
    // negative limit would make currentCount >= maxUsers true immediately
    // and block every single invite.
    if (company.limits.maxUsers > 0 && currentCount >= company.limits.maxUsers) {
      return next(new AppError(`User limit reached (${company.limits.maxUsers}). Upgrade your plan to add more members.`, 403));
    }

    const user = await createInvitedUser({ companyId: req.companyId, name, email, role, inviter: req.user, companyName: company.companyName });

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id,
      action: 'user.invite', resource: 'User', resourceId: user._id,
      description: `Invited ${email} as ${role}`, ip: req.ip,
    });

    res.status(201).json({ success: true, data: user, message: 'Team member invited. They will receive an email to set up their account.' });
  } catch (err) {
    if (err.statusCode) return next(new AppError(err.message, err.statusCode));
    next(err);
  }
};

// ── POST /users/team/bulk-invite (manager+) ─────────────────────────────────
// Accepts { members: [{ name, email, role }] } — e.g. parsed from a CSV on
// the frontend. Each row is independent: one bad row (duplicate email,
// invalid role, limit reached mid-batch) doesn't abort the rest. Returns a
// per-row result so the UI can show exactly what happened to each invite.
exports.bulkInviteMembers = async (req, res, next) => {
  try {
    const { members } = req.body;
    if (!Array.isArray(members) || members.length === 0) {
      return next(new AppError('Provide at least one team member to invite.', 400));
    }
    if (members.length > 100) return next(new AppError('Invite up to 100 members at a time.', 400));

    const company = await Company.findById(req.companyId).select('limits companyName');
    let currentCount = await User.countDocuments({ companyId: req.companyId, status: 'active' });

    const results = [];
    for (const raw of members) {
      const email = String(raw.email || '').trim().toLowerCase();
      const name = String(raw.name || '').trim();
      const role = raw.role === 'manager' ? 'manager' : 'employee';

      if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
        results.push({ email: raw.email, status: 'failed', message: 'Missing or invalid name/email.' });
        continue;
      }
      const roleError = canInviteAs(req.user.role, role);
      if (roleError) { results.push({ email, status: 'failed', message: roleError.message }); continue; }
      if (company.limits.maxUsers > 0 && currentCount >= company.limits.maxUsers) {
        results.push({ email, status: 'failed', message: `User limit reached (${company.limits.maxUsers}).` });
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const user = await createInvitedUser({ companyId: req.companyId, name, email, role, inviter: req.user, companyName: company.companyName });
        currentCount += 1;
        results.push({ email, status: 'invited', id: user._id });
      } catch (err) {
        results.push({ email, status: 'failed', message: err.statusCode ? err.message : 'Could not invite this member.' });
      }
    }

    const invitedCount = results.filter((r) => r.status === 'invited').length;
    if (invitedCount > 0) {
      await writeAuditLog({
        companyId: req.companyId, userId: req.user._id,
        action: 'user.invite', resource: 'User',
        description: `Bulk-invited ${invitedCount} of ${members.length} team member(s)`, ip: req.ip,
      });
    }

    res.status(200).json({ success: true, data: results, invited: invitedCount, failed: results.length - invitedCount });
  } catch (err) { next(err); }
};

// ── POST /users/team/:id/resend-invite (manager+) ───────────────────────────
// Only for someone who never logged in yet — resending would otherwise be a
// backdoor way to force a fresh setup link (and invalidate the old one) onto
// an account that's already active and in use.
exports.resendInvite = async (req, res, next) => {
  try {
    const member = await User.findOne({ _id: req.params.id, companyId: req.companyId }).select('name email role lastLogin');
    if (!member) return next(new AppError('Team member not found.', 404));
    if (member.lastLogin) return next(new AppError('This member has already logged in — resend only applies to a pending invite.', 400));

    const company = await Company.findById(req.companyId).select('companyName');
    const { token, hash } = generateResetToken();
    member.passwordResetToken = hash;
    member.passwordResetExpires = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await member.save();

    const setupLink = `${clientUrl()}/reset-password/${token}`;
    emailService.sendTeamInvite(member.email, member.name, req.user.name, company.companyName, setupLink, member.role, true).then(() => {
      logger.info(`✅ Invite reminder sent to ${member.email}`);
    }).catch((err) => {
      logger.warn(`⚠️  Invite reminder failed (${err.message}) — setup link: ${setupLink}`);
    });

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.invite', resource: 'User', resourceId: member._id, description: `Resent invite to ${member.email}`, ip: req.ip });
    res.status(200).json({ success: true, message: `Invite reminder sent to ${member.email}` });
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

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'user.department_change', resource: 'User', resourceId: req.params.id, metadata: { department: department || null }, ip: req.ip });
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
