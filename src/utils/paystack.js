'use strict';

const axios = require('axios');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('./logger');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

/**
 * Thin wrapper around the Paystack REST API. Turns provider / network errors
 * into readable operational AppErrors so the client sees the real reason
 * (bad bank code, test/live mismatch, unresolved account, …).
 */
async function paystackAPI(method, endpoint, data) {
  if (!PAYSTACK_SECRET) throw new AppError('Payment service not configured.', 503);
  try {
    const res = await axios({
      method,
      url: `${PAYSTACK_BASE}${endpoint}`,
      data,
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
    });
    return res.data;
  } catch (err) {
    const pmsg = err.response?.data?.message;
    const code = err.response?.status;
    logger.error(`Paystack ${method} ${endpoint} failed [${code || err.code}]: ${pmsg || err.message}`);
    if (pmsg) throw new AppError(`Paystack: ${pmsg}`, code && code < 500 ? 400 : 502);
    if (err.code === 'ECONNABORTED') throw new AppError('Paystack timed out. Please try again.', 504);
    throw new AppError('Could not reach the payment provider. Please try again.', 502);
  }
}

module.exports = { paystackAPI, PAYSTACK_SECRET, PAYSTACK_BASE };
