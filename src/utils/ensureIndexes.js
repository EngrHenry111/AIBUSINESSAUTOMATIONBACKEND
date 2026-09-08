'use strict';

const mongoose = require('mongoose');
const logger = require('./logger');

// Compound indexes that back the hot query paths. Mongoose also creates the
// per-schema indexes; this just guarantees the important composites exist even
// if a schema definition drifts. Runs once, right after the DB connects.
const SPECS = [
  ['leads', { companyId: 1, status: 1, createdAt: -1 }],
  ['invoices', { companyId: 1, status: 1, dueAt: 1 }],
  ['messages', { companyId: 1, recipientId: 1, isRead: 1 }],
  ['documents', { companyId: 1, status: 1 }],
  ['chats', { companyId: 1, userId: 1, updatedAt: -1 }],
  ['auditlogs', { companyId: 1, timestamp: -1 }],
];

async function ensureIndexes() {
  const db = mongoose.connection.db;
  if (!db) return;

  for (const [collection, keys] of SPECS) {
    try {
      await db.collection(collection).createIndex(keys, { background: true });
    } catch (err) {
      logger.warn(`ensureIndexes: ${collection} ${JSON.stringify(keys)} — ${err.message}`);
    }
  }
  logger.info(`✅ Indexes ensured on ${SPECS.length} collections`);
}

module.exports = ensureIndexes;
