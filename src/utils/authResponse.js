'use strict';

const { generateAccessToken, generateRefreshToken, setTokenCookies } = require('./generateTokens');

// Shared "you're logged in" response — used by password login, 2FA completion
// and backup-code login.
function sendTokenResponse(user, company, statusCode, res, extra = {}) {
  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);
  setTokenCookies(res, accessToken, refreshToken);
  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
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
