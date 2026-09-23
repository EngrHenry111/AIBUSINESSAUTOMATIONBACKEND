'use strict';

const crypto = require('crypto');
const StoreCustomer = require('../models/StoreCustomer');
const CustomerPoints = require('../models/CustomerPoints');
const Order = require('../models/Order');
const Product = require('../models/Product');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorMiddleware');
const { generateStoreCustomerToken } = require('../middleware/storeCustomerAuth');
const { generateResetToken } = require('../utils/generateTokens');

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

const publicCustomer = (c, extra = {}) => ({
  _id: c._id,
  name: c.name,
  email: c.email,
  phone: c.phone || null,
  addresses: c.addresses || [],
  orderCount: c.orderCount || 0,
  totalSpent: c.totalSpent || 0,
  isVerified: Boolean(c.isVerified),
  createdAt: c.createdAt,
  ...extra,
});

// Loyalty points are already tracked per email by the loyalty feature
// (CustomerPoints) — deliberately not duplicated as a stored field on
// StoreCustomer, which would just drift out of sync. Looked up live instead.
async function loyaltyPointsFor(companyId, email) {
  const record = await CustomerPoints.findOne({ companyId, customerEmail: email }).select('currentPoints tier');
  return { points: record?.currentPoints || 0, tier: record?.tier || 'Bronze' };
}

// ── POST /store/:slug/customer/register ─────────────────────────────────
exports.registerStoreCustomer = async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!name?.trim() || !EMAIL_RE.test(cleanEmail) || !password || password.length < 6) {
      return next(new AppError('Name, a valid email and a password of at least 6 characters are required.', 400));
    }

    const existing = await StoreCustomer.findOne({ companyId: req.store._id, email: cleanEmail });
    if (existing) return next(new AppError('An account with this email already exists. Try logging in instead.', 409));

    const customer = await StoreCustomer.create({ companyId: req.store._id, name: name.trim(), email: cleanEmail, phone, password });
    const token = generateStoreCustomerToken(customer._id, req.store._id);

    emailService.send({
      to: cleanEmail,
      subject: `Welcome to ${req.store.companyName}`,
      html: emailService.baseTemplate('Welcome', `
        <h2 style="color:#0f172a;margin:0 0 6px;">Welcome, ${customer.name}! 👋</h2>
        <p style="color:#475569;font-size:14px;">Your account at <strong>${req.store.companyName}</strong> is ready. Track orders, save addresses and build up loyalty points every time you shop.</p>
      `, { name: req.store.companyName, logo: req.store.logo }),
    }).catch(() => {});

    res.status(201).json({ success: true, data: { customer: publicCustomer(customer), token } });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('An account with this email already exists.', 409));
    next(err);
  }
};

// ── POST /store/:slug/customer/login ─────────────────────────────────────
exports.loginStoreCustomer = async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { password } = req.body;
    if (!email || !password) return next(new AppError('Email and password are required.', 400));

    const customer = await StoreCustomer.findOne({ companyId: req.store._id, email }).select('+password');
    if (!customer || !(await customer.comparePassword(password))) {
      return next(new AppError('Incorrect email or password.', 401));
    }

    customer.lastLoginAt = new Date();
    await customer.save();

    const token = generateStoreCustomerToken(customer._id, req.store._id);
    res.status(200).json({ success: true, data: { customer: publicCustomer(customer), token } });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/customer/me ─────────────────────────────────────────
exports.getStoreCustomer = async (req, res, next) => {
  try {
    const loyalty = await loyaltyPointsFor(req.store._id, req.storeCustomer.email);
    res.status(200).json({ success: true, data: publicCustomer(req.storeCustomer, { loyalty }) });
  } catch (err) { next(err); }
};

// ── PATCH /store/:slug/customer/me ───────────────────────────────────────
exports.updateStoreCustomer = async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    if (name !== undefined) req.storeCustomer.name = String(name).trim();
    if (phone !== undefined) req.storeCustomer.phone = phone;
    await req.storeCustomer.save();
    res.status(200).json({ success: true, data: publicCustomer(req.storeCustomer) });
  } catch (err) { next(err); }
};

// ── PUT /store/:slug/customer/addresses ──────────────────────────────────
// Replaces the whole list — simplest correct semantics for a short,
// owner-edited array like this (matches how tags/variants are handled
// elsewhere in this app rather than per-item CRUD endpoints).
exports.updateStoreCustomerAddresses = async (req, res, next) => {
  try {
    const { addresses } = req.body;
    if (!Array.isArray(addresses)) return next(new AppError('addresses must be an array.', 400));
    req.storeCustomer.addresses = addresses.slice(0, 10).map((a) => ({
      label: a.label || 'Home', address: a.address || '', city: a.city || '', state: a.state || '', isDefault: Boolean(a.isDefault),
    }));
    await req.storeCustomer.save();
    res.status(200).json({ success: true, data: req.storeCustomer.addresses });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/customer/orders ─────────────────────────────────────
exports.getCustomerOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({ companyId: req.store._id, 'customer.email': req.storeCustomer.email })
      .sort({ createdAt: -1 })
      .select('orderNumber status paymentStatus paymentMethod total currency items trackingNumber carrier estimatedDelivery deliveredAt createdAt')
      .lean();
    res.status(200).json({ success: true, data: orders });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/customer/wishlist ───────────────────────────────────
exports.getWishlist = async (req, res, next) => {
  try {
    const { publicProduct } = require('./storefrontController');
    const products = await Product.find({ _id: { $in: req.storeCustomer.wishlist }, companyId: req.store._id, status: { $ne: 'inactive' } }).lean();
    res.status(200).json({ success: true, data: products.map(publicProduct) });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/customer/wishlist/:productId ───────────────────────
exports.addToWishlist = async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!req.storeCustomer.wishlist.some((id) => String(id) === productId)) {
      req.storeCustomer.wishlist.push(productId);
      await req.storeCustomer.save();
      Product.updateOne({ _id: productId }, { $inc: { wishlistCount: 1 } }).catch(() => {});
    }
    res.status(200).json({ success: true, data: req.storeCustomer.wishlist });
  } catch (err) { next(err); }
};

// ── DELETE /store/:slug/customer/wishlist/:productId ─────────────────────
exports.removeFromWishlist = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const had = req.storeCustomer.wishlist.some((id) => String(id) === productId);
    req.storeCustomer.wishlist = req.storeCustomer.wishlist.filter((id) => String(id) !== productId);
    await req.storeCustomer.save();
    if (had) Product.updateOne({ _id: productId }, { $inc: { wishlistCount: -1 } }).catch(() => {});
    res.status(200).json({ success: true, data: req.storeCustomer.wishlist });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/customer/wishlist/sync ─────────────────────────────
// Merges a shopper's pre-login localStorage wishlist into their account the
// first time they log in on a device — union, never a destructive overwrite.
exports.syncWishlist = async (req, res, next) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds)) return next(new AppError('productIds must be an array.', 400));
    const existing = new Set(req.storeCustomer.wishlist.map(String));
    const merged = [...existing, ...productIds.map(String).filter((id) => !existing.has(id))];
    req.storeCustomer.wishlist = merged;
    await req.storeCustomer.save();
    res.status(200).json({ success: true, data: req.storeCustomer.wishlist });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/customer/points ─────────────────────────────────────
// A dedicated endpoint (rather than only the summary embedded in getMe) so
// the account page's Points tab can show full transaction history.
exports.getLoyaltyPoints = async (req, res, next) => {
  try {
    const record = await CustomerPoints.findOne({ companyId: req.store._id, customerEmail: req.storeCustomer.email });
    if (!record) return res.status(200).json({ success: true, data: { points: 0, tier: 'Bronze', totalPointsEarned: 0, transactions: [] } });

    res.status(200).json({
      success: true,
      data: {
        points: record.currentPoints,
        tier: record.tier,
        totalPointsEarned: record.totalPointsEarned,
        totalRedeemed: record.totalRedeemed,
        transactions: record.transactions.slice().reverse().slice(0, 50),
      },
    });
  } catch (err) { next(err); }
};

// ── PATCH /store/:slug/customer/password ─────────────────────────────────
exports.changeStoreCustomerPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return next(new AppError('New password must be at least 6 characters.', 400));

    const customer = await StoreCustomer.findById(req.storeCustomer._id).select('+password');
    if (!(await customer.comparePassword(currentPassword || ''))) {
      return next(new AppError('Current password is incorrect.', 401));
    }
    customer.password = newPassword;
    await customer.save();
    res.status(200).json({ success: true, message: 'Password updated.' });
  } catch (err) { next(err); }
};

// ── DELETE /store/:slug/customer/me ──────────────────────────────────────
exports.deleteStoreCustomer = async (req, res, next) => {
  try {
    await StoreCustomer.deleteOne({ _id: req.storeCustomer._id });
    res.status(200).json({ success: true, message: 'Account deleted.' });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/customer/forgot-password ───────────────────────────
// Same shape as the main app's authController.forgotPassword: always a
// generic success message (never reveals whether the email is registered),
// token logged server-side as a fallback, email sent best-effort.
exports.forgotStoreCustomerPassword = async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const successMsg = 'If that email has an account on this store, a reset link has been sent.';
    const customer = await StoreCustomer.findOne({ companyId: req.store._id, email });
    if (!customer) return res.status(200).json({ success: true, message: successMsg });

    const { token, hash } = generateResetToken();
    customer.resetToken = hash;
    customer.resetExpiry = Date.now() + 30 * 60 * 1000;
    await customer.save({ validateBeforeSave: false });

    const resetUrl = `${clientUrl()}/store/${req.store.storeSlug}/reset-password/${token}`;
    logger.warn(`Store customer password reset for ${email} @ ${req.store.storeSlug}: ${resetUrl}`);

    emailService.send({
      to: email,
      subject: `Reset your password — ${req.store.companyName}`,
      html: emailService.baseTemplate('Reset Your Password', `
        <h2 style="color:#0f172a;margin:0 0 6px;">Reset your password</h2>
        <p style="color:#475569;font-size:14px;">We received a request to reset the password for your account at <strong>${req.store.companyName}</strong>. This link expires in 30 minutes.</p>
        <p style="margin:20px 0 0;"><a href="${resetUrl}" style="background:#6366f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">Reset Password</a></p>
        <p style="color:#94a3b8;font-size:12px;margin-top:16px;">If you didn't request this, you can safely ignore this email.</p>
      `, { name: req.store.companyName, logo: req.store.logo }),
    }).catch((e) => logger.warn(`store customer reset email failed: ${e.message}`));

    res.status(200).json({ success: true, message: successMsg });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/customer/reset-password/:token ─────────────────────
exports.resetStoreCustomerPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return next(new AppError('Password must be at least 6 characters.', 400));

    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const customer = await StoreCustomer.findOne({
      companyId: req.store._id, resetToken: hash, resetExpiry: { $gt: Date.now() },
    }).select('+resetToken +resetExpiry');
    if (!customer) return next(new AppError('Reset link is invalid or has expired.', 400));

    customer.password = password;
    customer.resetToken = undefined;
    customer.resetExpiry = undefined;
    await customer.save();

    const token = generateStoreCustomerToken(customer._id, req.store._id);
    res.status(200).json({ success: true, data: { token }, message: 'Password reset. You are now logged in.' });
  } catch (err) { next(err); }
};
