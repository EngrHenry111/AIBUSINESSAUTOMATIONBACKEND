'use strict';

// Centralised, structured logging for security-relevant events, so they can
// be grepped/aggregated independently of ordinary request logs and are ready
// to ship to a SIEM later. Logged at warn/error on purpose — logger.js drops
// `info` in production (level is 'warn' outside development), and these
// events must survive there.
const logger = require('./logger');

function event(type, details = {}) {
  logger.warn(`[SECURITY] ${type} ${JSON.stringify(details)}`);
}

function critical(type, details = {}) {
  logger.error(`[SECURITY] ${type} ${JSON.stringify(details)}`);
}

module.exports = {
  logFailedLogin: (email, ip) => event('FAILED_LOGIN', { email, ip }),
  logAccountLockout: (email, ip) => critical('ACCOUNT_LOCKOUT', { email, ip }),
  logFailed2FA: (email, ip) => event('FAILED_2FA', { email, ip }),
  logSuspiciousActivity: (description, meta = {}) => critical('SUSPICIOUS_ACTIVITY', { description, ...meta }),
  logPasswordChange: (userId, email, ip) => event('PASSWORD_CHANGE', { userId, email, ip }),
  logNewDeviceLogin: (userId, email, ip) => event('NEW_DEVICE_LOGIN', { userId, email, ip }),
  logIpBlocked: (ip, failCount) => critical('IP_BLOCKED', { ip, failCount }),
};
