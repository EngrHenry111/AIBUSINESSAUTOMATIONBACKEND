'use strict';

const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const createLimiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
    skip: (req) => req.user?.role === 'super_admin',
    keyGenerator: (req) => req.user?.id || req.ip,
  });

// The general limiter runs before authentication, so keying it on req.user
// never matched: every request was counted per IP, and a whole school or
// office on one connection shared 200 requests per 15 minutes — a few staff
// clicking around (plus live-update refreshes) locked everyone out. A valid
// access token now gets its own, larger budget per user; anything else
// (logins, public pages, parents) stays per IP.
function callerKey(req) {
  if (req.rateLimitKey) return req.rateLimitKey;
  const header = req.headers.authorization || '';
  const raw = req.cookies?.accessToken || (header.startsWith('Bearer ') ? header.slice(7) : null);
  let key = `ip:${req.ip}`;
  if (raw && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(raw, process.env.JWT_SECRET);
      if (decoded?.id) key = `user:${decoded.id}`;
    } catch { /* expired or invalid — counted by IP */ }
  }
  req.rateLimitKey = key;
  return key;
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (req) => (callerKey(req).startsWith('user:') ? 1500 : 300),
  keyGenerator: callerKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again in 15 minutes.' },
});

const authLimiter = createLimiter(
  15 * 60 * 1000, 10,
  'Too many authentication attempts. Please try again in 15 minutes.'
);

const uploadLimiter = createLimiter(
  60 * 60 * 1000, 20,
  'Too many uploads. Please try again in 1 hour.'
);

const aiLimiter = createLimiter(
  60 * 1000, 30,
  'Too many AI requests. Please wait before trying again.'
);

// Public, unauthenticated storefront — no req.user to key on, so this is
// purely per-IP. Tighter than generalLimiter (which still applies too)
// since these routes have no login wall at all to slow down abuse.
const publicStoreLimiter = createLimiter(
  15 * 60 * 1000, 100,
  'Too many requests. Please try again in 15 minutes.'
);

// Chat widget messages hit Groq + embeddings per request, so this gets its
// own tighter, per-IP cap on top of publicStoreLimiter's general one.
const widgetMessageLimiter = createLimiter(
  60 * 60 * 1000, 20,
  'You’ve sent a lot of messages. Please try again in an hour.'
);

// School parent pages (admission form, fee lookup/payment, portal sign-in).
// Separate from authLimiter so parents on a school's shared network can't
// use up staff login attempts — and tight enough to stop admission-number
// guessing (each attempt also needs the guardian's phone/email).
const schoolParentLimiter = createLimiter(
  15 * 60 * 1000, 30,
  'Too many attempts. Please wait a few minutes and try again.'
);

module.exports = { generalLimiter, authLimiter, uploadLimiter, aiLimiter, publicStoreLimiter, widgetMessageLimiter, schoolParentLimiter };
