'use strict';

// One-shot data fixes that run automatically on every server startup.
// Each migration must be idempotent (safe to run again) and must never
// throw in a way that stops the server from booting — log and move on.
const Company = require('../models/Company');
const logger = require('./logger');

/**
 * Storefront rollout catch-up:
 *  1. Any company missing a storeSlug gets one generated from its name,
 *     guaranteed unique via Company.generateStoreSlug (done first, so step 2
 *     below can then find it by "has a slug").
 *  2. Any company that has a storeSlug but isn't enabled gets switched on.
 *     The store URL existing and being enabled is independent of payment
 *     setup — accepting payment is gated separately, at checkout, by
 *     paymentSettings.isPaymentSetup (see storefrontController). A company
 *     shouldn't have to configure a bank account before its store page can
 *     even be reached.
 */
async function migrateStoreEnabled() {
  try {
    // 1) Backfill missing slugs — one at a time so uniqueness can be checked
    // against companies already saved in this same pass.
    const noSlug = await Company.find({
      $or: [{ storeSlug: { $exists: false } }, { storeSlug: null }, { storeSlug: '' }],
    });

    let slugged = 0;
    for (const company of noSlug) {
      if (company.storeSlug) continue; // guard: only ever assign when empty
      // eslint-disable-next-line no-await-in-loop
      company.storeSlug = await Company.generateStoreSlug(company.companyName, company._id);
      // eslint-disable-next-line no-await-in-loop
      await company.save();
      slugged += 1;
      logger.info(`Fixed slug for: ${company.companyName} → ${company.storeSlug}`);
    }

    // 2) Enable every store that has a slug — payment setup is not a
    // precondition for the store existing, only for accepting checkout.
    const result = await Company.updateMany(
      { storeSlug: { $exists: true, $nin: [null, ''] }, storeEnabled: { $ne: true } },
      { $set: { storeEnabled: true } },
    );

    logger.info(`✅ Store migration: ${result.modifiedCount} store(s) enabled, ${slugged} slug(s) backfilled`);
    return { enabled: result.modifiedCount, slugged };
  } catch (err) {
    logger.error(`Store migration failed: ${err.message}`);
    return { enabled: 0, slugged: 0, error: err.message };
  }
}

module.exports = { migrateStoreEnabled };
