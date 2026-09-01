'use strict';

const rateLimit = require('express-rate-limit');

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

const generalLimiter = createLimiter(
  15 * 60 * 1000, 200,
  'Too many requests. Please try again in 15 minutes.'
);

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

module.exports = { generalLimiter, authLimiter, uploadLimiter, aiLimiter };
