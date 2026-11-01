'use strict';

// Staff who are on the books but never sign in (no phone, no email): they
// are ordinary User records so classes and timetables treat them like
// anyone else, with `noLogin: true` shutting the door on the account.
// User.email is required and unique, so each gets a placeholder on the
// reserved .invalid domain, which can never reach a real inbox.

const crypto = require('crypto');

const PLACEHOLDER_DOMAIN = 'no-login.invalid';

const placeholderEmail = () => `staff-${crypto.randomUUID()}@${PLACEHOLDER_DOMAIN}`;
const isPlaceholderEmail = (email) => String(email || '').toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
const unusablePassword = () => crypto.randomBytes(32).toString('hex');

module.exports = { placeholderEmail, isPlaceholderEmail, unusablePassword };
