'use strict';

const jwt = require('jsonwebtoken');
const StoreCustomer = require('../models/StoreCustomer');
const { AppError } = require('./errorMiddleware');

// Resolves :slug -> the live Company document once, as req.store, so every
// customer-account route (and authenticateStoreCustomer below) shares one
// lookup instead of each controller repeating it.
async function loadStore(req, res, next) {
  try {
    const { findStore } = require('../controllers/storefrontController');
    req.store = await findStore(req.params.slug);
    next();
  } catch (err) { next(err); }
}

// Deliberately separate from the main app's access/refresh cookie pair
// (see utils/generateTokens.js) — a store customer never touches the
// dashboard, so a single long-lived bearer token (sent by the SPA itself,
// not a cookie) is the simplest correct scheme here. The `type` claim
// stops this token from ever being mistaken for a main-app token, and vice
// versa, even though both are signed with the same JWT_SECRET.
function generateStoreCustomerToken(customerId, companyId) {
  return jwt.sign({ id: customerId, companyId: String(companyId), type: 'store_customer' }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
}

// Verifies the bearer token AND that it belongs to the store named in the
// URL — a token minted on Store A must never authenticate on Store B, even
// though both stores share the same JWT_SECRET.
async function authenticateStoreCustomer(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(new AppError('Please log in to continue.', 401));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'store_customer') return next(new AppError('Invalid session. Please log in again.', 401));
    if (String(decoded.companyId) !== String(req.store._id)) {
      return next(new AppError('This session does not belong to this store.', 401));
    }

    const customer = await StoreCustomer.findById(decoded.id);
    if (!customer || String(customer.companyId) !== String(req.store._id)) {
      return next(new AppError('Account not found. Please log in again.', 401));
    }

    req.storeCustomer = customer;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(new AppError('Session expired. Please log in again.', 401));
    if (err.name === 'JsonWebTokenError') return next(new AppError('Invalid session. Please log in again.', 401));
    next(err);
  }
}

module.exports = { generateStoreCustomerToken, authenticateStoreCustomer, loadStore };
