'use strict';

// One-shot data fixes that run automatically on every server startup.
// Each migration must be idempotent (safe to run again) and must never
// throw in a way that stops the server from booting — log and move on.
const Company = require('../models/Company');
const logger = require('./logger');

/**
 * Storefront rollout catch-up:
 *  1. Any company with payments configured but the store not enabled yet
 *     (e.g. it was set up before store auto-enable existed) gets switched on.
 *  2. Any company missing a storeSlug gets one generated from its name,
 *     guaranteed unique via Company.generateStoreSlug.
 */
async function migrateStoreEnabled() {
  try {
    // 1) Enable the store wherever payments are already ready.
    const result1 = await Company.updateMany(
      { 'paymentSettings.isPaymentSetup': true, storeEnabled: { $ne: true } },
      { $set: { storeEnabled: true } },
    );

    // 2) Backfill missing slugs — one at a time so uniqueness can be checked
    // against companies already saved in this same pass.
    const companies = await Company.find({
      $or: [{ storeSlug: { $exists: false } }, { storeSlug: null }, { storeSlug: '' }],
    });

    let slugged = 0;
    for (const company of companies) {
      if (company.storeSlug) continue; // guard: only ever assign when empty
      // eslint-disable-next-line no-await-in-loop
      company.storeSlug = await Company.generateStoreSlug(company.companyName, company._id);
      // eslint-disable-next-line no-await-in-loop
      await company.save();
      slugged += 1;
    }

    logger.info(`✅ Store migration: ${result1.modifiedCount} store(s) enabled, ${slugged} slug(s) backfilled`);
    return { enabled: result1.modifiedCount, slugged };
  } catch (err) {
    logger.error(`Store migration failed: ${err.message}`);
    return { enabled: 0, slugged: 0, error: err.message };
  }
}

module.exports = { migrateStoreEnabled };
