'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// tokenVersion is embedded so authMiddleware can reject every token issued
// before a password change, forcing re-login everywhere except the device
// that made the change (see User.tokenVersion).
const generateAccessToken = (userId, tokenVersion = 0) =>
  jwt.sign({ id: userId, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });

const generateRefreshToken = (userId, tokenVersion = 0) =>
  jwt.sign({ id: userId, tokenVersion }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });

const generateResetToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
};

// Render always sets RENDER=true regardless of whatever NODE_ENV is (or
// isn't) configured on the service dashboard. Trusting NODE_ENV alone bit us
// once already: if it's left unset in Render's env vars, isProd silently
// evaluates false, cookies fall back to SameSite=Lax, and a Lax cookie is
// never attached to the cross-site XHR/fetch calls the bislyai.com frontend
// makes to this onrender.com API — only login's own response still carries
// user data, so the dashboard renders for a moment before every subsequent
// request 401s with no cookie and the client bounces back to /login.
const isProd = () => process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

const setTokenCookies = (res, accessToken, refreshToken) => {
  const prod = isProd();
  // Frontend (bislyai.com) and API (onrender.com) are different sites, so cookies
  // must be SameSite=None; Secure to be sent on cross-site requests. In dev
  // (same-origin via the Vite proxy) Lax is fine and works without HTTPS.
  const crossSite = { httpOnly: true, secure: prod, sameSite: prod ? 'none' : 'lax' };
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

module.exports = { generateAccessToken, generateRefreshToken, generateResetToken, setTokenCookies, isProd };
