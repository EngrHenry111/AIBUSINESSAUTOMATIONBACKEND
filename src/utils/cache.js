'use strict';

const NodeCache = require('node-cache');

// In-memory cache for expensive read endpoints. 5-minute default TTL,
// checked for expiry every 60s. `useClones: false` keeps get/set cheap.
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });

module.exports = cache;
