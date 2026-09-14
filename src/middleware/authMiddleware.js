'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { AppError } = require('./errorMiddleware');

const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      return next(new AppError('Authentication required. Please log in.', 401));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('+refreshToken');

    if (!user) {
      return next(new AppError('User no longer exists.', 401));
    }

    // Tokens signed before the account's last password change carry a stale
    // (or absent, for tokens issued pre-rollout — treated as 0) version and
    // are rejected, forcing every other device to sign in again.
    if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return next(new AppError('Session expired. Please log in again.', 401));
    }

    if (user.status !== 'active') {
      return next(new AppError('Account is not active. Please contact support.', 403));
    }

    if (user.isLocked()) {
      return next(new AppError('Account temporarily locked due to failed login attempts.', 423));
    }

    req.user = user;
    req.companyId = user.companyId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Session expired. Please log in again.', 401));
    }
    if (err.name === 'JsonWebTokenError') {
      return next(new AppError('Invalid authentication token.', 401));
    }
    next(err);
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (user && user.status === 'active') {
        req.user = user;
        req.companyId = user.companyId;
      }
    }
    next();
  } catch {
    next();
  }
};

module.exports = { protect, optionalAuth };
