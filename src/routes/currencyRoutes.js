'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { AppError } = require('../middleware/errorMiddleware');
const { getExchangeRates, convertAmount, SUPPORTED_CURRENCIES } = require('../services/currencyService');

const router = express.Router();
// Rates are global, non-tenant data — login is required only to keep this
// from becoming an open, unauthenticated proxy onto the upstream rate API.
router.use(protect);

// ── GET /currency/rates ──────────────────────────────────────────────────
router.get('/rates', async (req, res, next) => {
  try {
    const { rates, lastUpdated, source } = await getExchangeRates();
    res.status(200).json({
      success: true,
      data: { base: 'NGN', rates, lastUpdated, source, supportedCurrencies: SUPPORTED_CURRENCIES },
    });
  } catch (err) { next(err); }
});

// ── GET /currency/convert?amount=1000&from=NGN&to=USD ────────────────────
router.get('/convert', async (req, res, next) => {
  try {
    const amount = Number(req.query.amount);
    const from = String(req.query.from || '').toUpperCase();
    const to = String(req.query.to || '').toUpperCase();
    if (!Number.isFinite(amount) || amount < 0) return next(new AppError('A valid, non-negative amount is required.', 400));
    if (!from || !to) return next(new AppError('Both from and to currency codes are required.', 400));

    const { rates, lastUpdated } = await getExchangeRates();
    if (from !== 'NGN' && !rates[from]) return next(new AppError(`Unsupported currency: ${from}`, 400));
    if (to !== 'NGN' && !rates[to]) return next(new AppError(`Unsupported currency: ${to}`, 400));

    const converted = convertAmount(amount, from, to, rates);
    res.status(200).json({
      success: true,
      data: { amount, from, to, converted: Math.round(converted * 100) / 100, rate: convertAmount(1, from, to, rates), lastUpdated },
    });
  } catch (err) { next(err); }
});

module.exports = router;
