'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const generateAccessToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });

const generateRefreshToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });

const generateResetToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
};

const setTokenCookies = (res, accessToken, refreshToken) => {
  const isProd = process.env.NODE_ENV === 'production';
  // Frontend (bislyai.com) and API (onrender.com) are different sites, so cookies
  // must be SameSite=None; Secure to be sent on cross-site requests. In dev
  // (same-origin via the Vite proxy) Lax is fine and works without HTTPS.
  const crossSite = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' };
  res.cookie('accessToken', accessToken, {
    ...crossSite,
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refreshToken', refreshToken, {
    ...crossSite,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth/refresh-token',
  });
};

module.exports = { generateAccessToken, generateRefreshToken, generateResetToken, setTokenCookies };
