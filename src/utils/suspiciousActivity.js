'use strict';

// IP-based abuse detection: repeated failed logins from one address get that
// address blocked outright, and a burst of traffic from one address gets
// logged even when it's still under the general rate limiter's threshold.
// State lives in the same in-memory cache used elsewhere (utils/cache.js) —
// fine for a single-instance deployment; a restart simply clears it.
const cache = require('./cache');
const securityLogger = require('./securityLogger');
const logger = require('./logger');

const FAIL_WINDOW_SECONDS = 60 * 60;   // count failed logins over 1 hour
const FAIL_THRESHOLD = 10;              // …block the IP once it hits this many
const BLOCK_SECONDS = 24 * 60 * 60;     // …for 24 hours
const RATE_WINDOW_SECONDS = 60;         // "unusual activity" burst window
const RATE_THRESHOLD = 100;             // …100+ requests/minute from one IP
const ALERT_EMAIL = 'henryengrakpan@gmail.com';

const failKey = (ip) => `sec_fail_${ip}`;
const blockKey = (ip) => `sec_blocked_${ip}`;
const rateKey = (ip) => `sec_rate_${ip}`;

function isIpBlocked(ip) {
  return Boolean(ip && cache.get(blockKey(ip)));
}

// Call on every failed login attempt (wrong password, unknown email, locked
// account, failed 2FA). Blocks the IP and emails an alert once the
// threshold is crossed within the window.
async function recordFailedLogin(ip, email) {
  if (!ip) return 0;
  const count = (cache.get(failKey(ip)) || 0) + 1;
  cache.set(failKey(ip), count, FAIL_WINDOW_SECONDS);

  if (count >= FAIL_THRESHOLD && !isIpBlocked(ip)) {
    cache.set(blockKey(ip), true, BLOCK_SECONDS);
    securityLogger.logIpBlocked(ip, count);

    // Fire-and-forget — an alert email must never hold up (or crash) the
    // request that triggered it.
    try {
      const emailService = require('../services/emailService');
      emailService.send({
        to: ALERT_EMAIL,
        subject: `Security Alert: IP blocked after ${count} failed logins`,
        html: `
          <h2>Suspicious login activity blocked</h2>
          <p>The IP address <strong>${ip}</strong> was blocked for 24 hours after
          <strong>${count}</strong> failed login attempts within one hour.</p>
          <p>Last attempted email: ${email || 'unknown'}</p>
          <p>— BizlyAI security monitor</p>
        `,
      }).catch((err) => logger.error(`Security alert email failed: ${err.message}`));
    } catch (err) {
      logger.error(`Security alert email failed: ${err.message}`);
    }
  }
  return count;
}

// Reject requests from an already-blocked IP before they do any real work.
function checkIpBlocked(req, res, next) {
  if (isIpBlocked(req.ip)) {
    return res.status(403).json({
      success: false,
      message: 'Too many failed attempts from this network. Try again later.',
    });
  }
  next();
}

// Purely observational — logs once when an IP crosses the burst threshold in
// a given minute; it never blocks (express-rate-limit already enforces the
// hard caps elsewhere).
function trackRequestRate(req, res, next) {
  const ip = req.ip;
  if (ip) {
    const count = (cache.get(rateKey(ip)) || 0) + 1;
    cache.set(rateKey(ip), count, RATE_WINDOW_SECONDS);
    if (count === RATE_THRESHOLD) {
      securityLogger.logSuspiciousActivity('High request rate from IP', { ip, requestsPerMinute: count });
    }
  }
  next();
}

module.exports = { isIpBlocked, recordFailedLogin, checkIpBlocked, trackRequestRate };
