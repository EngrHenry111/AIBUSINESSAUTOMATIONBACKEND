'use strict';

const axios = require('axios');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

// Fallback rates (NGN base — value = how much of that currency equals 1 NGN),
// used whenever the live API is unreachable and to seed SUPPORTED_CURRENCIES.
// Update these periodically; they're a safety net, not the primary source.
const EXCHANGE_RATES = {
  base: 'NGN',
  rates: {
    NGN: 1,
    USD: 0.00063,
    GBP: 0.00050,
    EUR: 0.00058,
    GHS: 0.0095,
    KES: 0.082,
    ZAR: 0.012,
    UGX: 2.35,
    TZS: 1.65,
    XOF: 0.38,
    CAD: 0.00086,
    AUD: 0.00097,
  },
};

const SUPPORTED_CURRENCIES = Object.keys(EXCHANGE_RATES.rates);
const CACHE_KEY = 'exchange_rates_ngn';
// The free open.er-api.com tier and exchangerate-api.com's free tier both cap
// monthly requests low enough that fetching per-invoice would exhaust them
// almost immediately — an hour-long cache keeps this well under any
// reasonable plan's limit while still being "live" for practical purposes.
const CACHE_TTL_SECONDS = 60 * 60;

const SYMBOLS = {
  NGN: '₦', USD: '$', GBP: '£', EUR: '€',
  GHS: '₵', KES: 'KSh', ZAR: 'R',
  UGX: 'USh', TZS: 'TSh', XOF: 'CFA',
  CAD: 'CA$', AUD: 'A$',
};

/**
 * Returns { rates, lastUpdated, source }. `rates` is always NGN-based
 * (rates[X] = how much of currency X equals 1 NGN), whether it came from the
 * live API or the hardcoded fallback, so convertAmount() never needs to care
 * which source it got.
 */
async function getExchangeRates() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/NGN', { timeout: 5000 });
    if (response.data?.result === 'success' && response.data.rates) {
      const result = { rates: response.data.rates, lastUpdated: new Date(), source: 'live' };
      cache.set(CACHE_KEY, result, CACHE_TTL_SECONDS);
      return result;
    }
    throw new Error('Unexpected response shape from exchange rate API');
  } catch (err) {
    logger.warn(`Exchange rate API failed, using cached/fallback rates: ${err.message}`);
    const result = { rates: EXCHANGE_RATES.rates, lastUpdated: new Date(), source: 'fallback' };
    // Cache the fallback too, briefly — so a sustained outage doesn't turn
    // into a retry-every-call storm against a failing API.
    cache.set(CACHE_KEY, result, 300);
    return result;
  }
}

/**
 * @param {number} amount
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {Object} rates - NGN-based rates map (see getExchangeRates)
 */
function convertAmount(amount, fromCurrency, toCurrency, rates) {
  if (fromCurrency === toCurrency) return amount;
  const inNGN = fromCurrency === 'NGN' ? amount : amount / rates[fromCurrency];
  return toCurrency === 'NGN' ? inNGN : inNGN * rates[toCurrency];
}

function formatCurrency(amount, currency) {
  const symbol = SYMBOLS[currency] || `${currency} `;
  return `${symbol}${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * The NGN value of one unit of `currency` at current rates — this is the
 * "1 USD = ₦1,587" number shown on invoices and used to compute ngnEquivalent.
 * Returns 1 for NGN itself.
 */
async function ngnPerUnit(currency) {
  if (currency === 'NGN') return 1;
  const { rates } = await getExchangeRates();
  const rate = rates[currency];
  if (!rate) return null; // unsupported/unknown currency code
  return 1 / rate;
}

/**
 * Computes the fields an Invoice needs to record at creation/generation time
 * so P&L and dashboard reporting can sum everything in NGN regardless of
 * what currency the invoice was actually issued in.
 */
async function currencyFieldsFor(currency, total) {
  const cur = currency || 'NGN';
  if (cur === 'NGN') return { exchangeRate: 1, ngnEquivalent: total };
  const rate = await ngnPerUnit(cur);
  if (!rate) return { exchangeRate: null, ngnEquivalent: total }; // unknown currency — best effort, treat as already-NGN
  return { exchangeRate: Math.round(rate * 100) / 100, ngnEquivalent: Math.round(total * rate * 100) / 100 };
}

module.exports = {
  getExchangeRates,
  convertAmount,
  formatCurrency,
  ngnPerUnit,
  currencyFieldsFor,
  SUPPORTED_CURRENCIES,
};
