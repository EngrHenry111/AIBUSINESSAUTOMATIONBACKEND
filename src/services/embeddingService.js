'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || 'http://127.0.0.1:8000';
const TIMEOUT = 30000;

// No caching — always check live so starting the service is picked up immediately
async function checkHealth() {
  try {
    await axios.get(`${EMBEDDING_SERVICE_URL}/health`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function getEmbedding(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot embed empty text');
  }

  const isHealthy = await checkHealth();
  if (!isHealthy) {
    throw new Error('Embedding service is unavailable. Please ensure the Python service is running on port 8000.');
  }

  try {
    const response = await axios.post(
      `${EMBEDDING_SERVICE_URL}/embed`,
      { text: text.slice(0, 8000) },
      { timeout: TIMEOUT, headers: { 'Content-Type': 'application/json' } }
    );
    return response.data.embedding;
  } catch (err) {
    logger.error('Embedding request failed:', err.message);
    throw new Error(`Embedding failed: ${err.message}`);
  }
}

async function getEmbeddingsBatch(texts) {
  const results = [];
  for (const text of texts) {
    const embedding = await getEmbedding(text);
    results.push(embedding);
    await new Promise(r => setTimeout(r, 50));
  }
  return results;
}

module.exports = { getEmbedding, getEmbeddingsBatch, checkHealth };