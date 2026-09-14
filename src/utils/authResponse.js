'use strict';

const { generateAccessToken, generateRefreshToken, setTokenCookies } = require('./generateTokens');

// Shared "you're logged in" response — used by password login, 2FA completion
// and backup-code login. Tokens travel only as httpOnly cookies (set below);
// they are deliberately never included in the JSON body so client-side JS —
// including anything an XSS bug might run — has no way to read them.
//
// This is also the single place that mints and persists the refresh token.
// Callers must NOT generate/save their own beforehand — an earlier version
// had each caller save one refreshToken while this function minted and
// cookied a second, different one, so the two intermittently diverged
// (whenever the two generateRefreshToken() calls landed in different JWT
// `iat` seconds) and /auth/refresh-token failed right after a fresh login.
async function sendTokenResponse(user, company, statusCode, res, extra = {}) {
  const accessToken = generateAccessToken(user._id, user.tokenVersion);
  const refreshToken = generateRefreshToken(user._id, user.tokenVersion);
  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });
  setTokenCookies(res, accessToken, refreshToken);
  res.status(statusCode).json({
    success: true,
    user: typeof user.toJSON === 'function' ? user.toJSON() : user,
    company: company ? {
      id: company._id,
      name: company.companyName,
      plan: company.subscription?.plan,
      settings: company.settings,
    } : null,
    ...extra,
  });
}

module.exports = { sendTokenResponse };
