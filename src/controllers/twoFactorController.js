'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const User = require('../models/User');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { sendTokenResponse } = require('../utils/authResponse');
const { generateRefreshToken } = require('../utils/generateTokens');

const hashCode = (c) => crypto.createHash('sha256').update(String(c)).digest('hex');
const cleanToken = (t) => String(t || '').replace(/\s+/g, '');

// ── GET /2fa/setup ──────────────────────────────────────────────────────
exports.setup2FA = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+twoFactorSecret');
    if (user.twoFactorEnabled) return next(new AppError('Two-factor authentication is already enabled.', 400));

    const secret = speakeasy.generateSecret({ name: `BizlyAI (${user.email})`, issuer: 'BizlyAI' });
    user.twoFactorSecret = secret.base32; // stored but not enabled until verified
    await user.save({ validateBeforeSave: false });

    const qrCode = await qrcode.toDataURL(secret.otpauth_url);
    res.status(200).json({ success: true, data: { qrCode, secret: secret.base32 } });
  } catch (err) { next(err); }
};

// ── POST /2fa/verify ────────────────────────────────────────────────────
exports.verify2FA = async (req, res, next) => {
  try {
    const token = cleanToken(req.body.token);
    if (!/^\d{6}$/.test(token)) return next(new AppError('Enter the 6-digit code from your app.', 400));

    const user = await User.findById(req.user._id).select('+twoFactorSecret +backupCodes');
    if (!user.twoFactorSecret) return next(new AppError('Start 2FA setup first.', 400));

    const ok = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token, window: 1 });
    if (!ok) return next(new AppError('That code is incorrect. Check the time on your phone and try again.', 400));

    const plainCodes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex'));
    user.backupCodes = plainCodes.map((c) => ({ code: hashCode(c), used: false }));
    user.twoFactorEnabled = true;
    await user.save({ validateBeforeSave: false });

    await writeAuditLog({ companyId: user.companyId, userId: user._id, action: 'user.2fa_enable', ip: req.ip });
    res.status(200).json({ success: true, backupCodes: plainCodes });
  } catch (err) { next(err); }
};

// ── DELETE /2fa ─────────────────────────────────────────────────────────
exports.disable2FA = async (req, res, next) => {
  try {
    const token = cleanToken(req.body.token);
    const user = await User.findById(req.user._id).select('+twoFactorSecret +backupCodes');
    if (!user.twoFactorEnabled) return next(new AppError('Two-factor authentication is not enabled.', 400));

    const totpOk = user.twoFactorSecret &&
      speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token, window: 1 });
    const backup = !totpOk && (user.backupCodes || []).find((b) => !b.used && b.code === hashCode(token.toLowerCase()));

    if (!totpOk && !backup) return next(new AppError('Incorrect code — 2FA was not disabled.', 400));

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.backupCodes = undefined;
    await user.save({ validateBeforeSave: false });

    await writeAuditLog({ companyId: user.companyId, userId: user._id, action: 'user.2fa_disable', ip: req.ip });
    res.status(200).json({ success: true, message: 'Two-factor authentication disabled.' });
  } catch (err) { next(err); }
};

// ── POST /auth/2fa/backup — log in with a one-time backup code ──────────
exports.verifyBackupCode = async (req, res, next) => {
  try {
    const { tempToken } = req.body;
    const code = cleanToken(req.body.code).toLowerCase();
    if (!tempToken || !code) return next(new AppError('A backup code is required.', 400));

    let decoded;
    try { decoded = jwt.verify(tempToken, process.env.JWT_SECRET); }
    catch { return next(new AppError('Your login session expired. Please sign in again.', 401)); }
    if (!decoded.twofa) return next(new AppError('Invalid login session.', 401));

    const user = await User.findById(decoded.id).select('+backupCodes +refreshToken');
    if (!user || !user.twoFactorEnabled) return next(new AppError('Two-factor authentication is not set up.', 400));

    const match = (user.backupCodes || []).find((b) => !b.used && b.code === hashCode(code));
    if (!match) return next(new AppError('Invalid or already-used backup code.', 401));

    match.used = true;
    user.lastLogin = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    user.loginIPs = [...(user.loginIPs || []).slice(-9), { ip: req.ip, timestamp: new Date() }];
    user.refreshToken = generateRefreshToken(user._id);
    await user.save({ validateBeforeSave: false });

    const company = user.companyId ? await Company.findById(user.companyId) : null;
    await writeAuditLog({ companyId: user.companyId, userId: user._id, action: 'user.login_2fa_backup', ip: req.ip });

    const remaining = user.backupCodes.filter((b) => !b.used).length;
    sendTokenResponse(user, company, 200, res, { usedBackupCode: true, backupCodesRemaining: remaining });
  } catch (err) { next(err); }
};
