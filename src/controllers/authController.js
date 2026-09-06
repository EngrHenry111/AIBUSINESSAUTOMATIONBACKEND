'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Company = require('../models/Company');
const { generateAccessToken, generateRefreshToken, generateResetToken, setTokenCookies } = require('../utils/generateTokens');
const { writeAuditLog } = require('../utils/auditLog');
const { AppError } = require('../middleware/errorMiddleware');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const sendTokenResponse = (user, company, statusCode, res) => {
  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);
  setTokenCookies(res, accessToken, refreshToken);
  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    user: user.toJSON(),
    company: company ? {
      id: company._id,
      name: company.companyName,
      plan: company.subscription?.plan,
      settings: company.settings,
    } : null,
  });
};

exports.register = async (req, res, next) => {
  try {
    const { name, email, password, companyName, industry } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return next(new AppError('Email already registered.', 409));

    const tempUser = new User({ name, email, password, role: 'company_owner' });
    const company = await Company.create({ companyName, industry, owner: tempUser._id });
    const user = await User.create({
      name, email, password, role: 'company_owner',
      companyId: company._id, status: 'active',
    });
    company.owner = user._id;
    await company.save();

    const refreshToken = generateRefreshToken(user._id);
    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    // Welcome email — non-blocking, never crashes the request
    emailService.sendWelcome(email, name, companyName).catch(err =>
      logger.warn(`Welcome email failed: ${err.message}`)
    );

    await writeAuditLog({
      companyId: company._id, userId: user._id,
      action: 'user.register', description: `New company: ${companyName}`, ip: req.ip,
    });

    sendTokenResponse(user, company, 201, res);
  } catch (err) { next(err); }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password +refreshToken');
    if (!user) return next(new AppError('Invalid email or password.', 401));
    if (user.isLocked()) return next(new AppError('Account locked. Try again in 2 hours.', 423));

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return next(new AppError('Invalid email or password.', 401));
    }
    if (user.status !== 'active') return next(new AppError('Account is not active.', 403));

    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    user.lastLogin = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    user.loginIPs = [...(user.loginIPs || []).slice(-9), { ip: req.ip, timestamp: new Date() }];
    user.refreshToken = generateRefreshToken(user._id);
    await user.save({ validateBeforeSave: false });

    const company = user.companyId ? await Company.findById(user.companyId) : null;
    await writeAuditLog({ companyId: user.companyId, userId: user._id, action: 'user.login', ip: req.ip });
    sendTokenResponse(user, company, 200, res);
  } catch (err) { next(err); }
};

exports.googleCallback = async (req, res, next) => {
  try {
    const user = req.user;
    const company = user.companyId ? await Company.findById(user.companyId) : null;
    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);
    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });
    const frontendUrl = process.env.CLIENT_URL?.split(',')[0] || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/auth/google/callback?token=${accessToken}&refresh=${refreshToken}`);
  } catch (err) { next(err); }
};

exports.logout = async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $unset: { refreshToken: 1 } });
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken', { path: '/api/v1/auth/refresh-token' });
    res.status(200).json({ success: true, message: 'Logged out successfully.' });
  } catch (err) { next(err); }
};

exports.refreshToken = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken || req.body.refreshToken || req.headers['x-refresh-token'];
    if (!token) return next(new AppError('Refresh token required.', 401));
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== token) return next(new AppError('Invalid refresh token.', 401));
    const newAccessToken = generateAccessToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);
    user.refreshToken = newRefreshToken;
    await user.save({ validateBeforeSave: false });
    setTokenCookies(res, newAccessToken, newRefreshToken);
    res.status(200).json({ success: true, accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(new AppError('Refresh token expired. Please log in.', 401));
    next(err);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const company = req.user.companyId ? await Company.findById(req.user.companyId) : null;
    const { getSubscriptionState, graceRemainingDays } = require('../utils/subscriptionChecker');
    // Super admins aren't tied to a company subscription — never soft-block them.
    const subscriptionState = user.role === 'super_admin' ? 'active' : getSubscriptionState(company);
    const graceDays = subscriptionState === 'grace' ? graceRemainingDays(company) : null;
    res.status(200).json({ success: true, user, company, subscriptionState, graceDays });
  } catch (err) { next(err); }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const successMsg = 'If that email exists, a reset link has been sent. Check your inbox.';
    const user = await User.findOne({ email });
    if (!user) return res.status(200).json({ success: true, message: successMsg });

    const { token, hash } = generateResetToken();
    user.passwordResetToken = hash;
    user.passwordResetExpires = Date.now() + 10 * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    // Always log the token so it works even when email is blocked
    logger.info(`🔑 PASSWORD RESET TOKEN for ${email}: ${token}`);
    logger.info(`🔗 Reset URL: ${process.env.CLIENT_URL?.split(',')[0] || 'http://localhost:5173'}/reset-password/${token}`);

    // Try to send email — but NEVER fail the request if email doesn't work
    emailService.sendPasswordReset(email, user.name, token).then(() => {
      logger.info(`✅ Reset email sent to ${email}`);
    }).catch(err => {
      logger.warn(`⚠️  Reset email failed (${err.message}) — token logged above, user can still reset manually`);
    });

    // Always return success — email failure is logged, not returned to user
    res.status(200).json({ success: true, message: successMsg });

  } catch (err) { next(err); }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const user = await User.findOne({
      passwordResetToken: hash,
      passwordResetExpires: { $gt: Date.now() },
    });
    if (!user) return next(new AppError('Reset link is invalid or has expired.', 400));

    user.password = req.body.password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();

    res.status(200).json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) { next(err); }
};