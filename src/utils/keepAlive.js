'use strict';

const axios = require('axios');
const logger = require('./logger');

/**
 * Pings the embedding service every 10 minutes to prevent
 * Render free tier from spinning it down
 */
function startKeepAlive() {
  const embeddingUrl = process.env.EMBEDDING_SERVICE_URL;
  if (!embeddingUrl || process.env.NODE_ENV !== 'production') return;

  logger.info('Starting keep-alive ping for embedding service...');

  setInterval(async () => {
    try {
      await axios.get(`${embeddingUrl}/health`, { timeout: 10000 });
      logger.debug('Keep-alive ping: embedding service OK');
    } catch (err) {
      logger.warn(`Keep-alive ping failed: ${err.message}`);
    }
  }, 10 * 60 * 1000); // every 10 minutes
}

module.exports = { startKeepAlive };