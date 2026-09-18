'use strict';

const { paystackAPI } = require('./paystack');
const Company = require('../models/Company');
const Order = require('../models/Order');
const logger = require('./logger');

// Runs every 15 minutes; each run re-scans a wider window than that so a
// missed run (deploy, restart, brief outage) never leaves a gap — the
// per-transaction existence check makes re-scanning the same window safe.
const LOOKBACK_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_PAGES = 5; // 5 x 100 = 500 transactions per run, ample for the lookback window

/**
 * Safety net for storefront orders that never got created — normally that
 * only happens via the Paystack webhook (primary path) or a customer
 * landing back on /store/:slug/success (backup path, verifyStorePayment).
 * Both can be missed: the webhook if it's misconfigured or Paystack's
 * retries are exhausted, the return-page path if the customer pays via bank
 * transfer/USSD and never comes back to the tab. This asks Paystack
 * directly for recently-successful transactions and fulfils any storefront
 * order that's still missing, using the exact same fulfilStorefrontOrder()
 * the other two paths use — so behaviour (stock, emails, notifications,
 * sockets) is identical no matter which of the three paths catches it, and
 * calling it twice for the same reference is always a no-op.
 *
 * IMPORTANT: this Paystack account is currently shared with another,
 * unrelated project (a deliberate, temporary choice — see project notes),
 * so /transaction here returns BOTH projects' transactions mixed together.
 * Every transaction is filtered on metadata.type === 'storefront_order' AND
 * a resolvable BizlyAI Company for metadata.companyId before anything is
 * touched, so the other project's transactions are always ignored.
 */
async function reconcileStorefrontOrders() {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_MS);

    const transactions = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const r = await paystackAPI(
        'GET',
        `/transaction?status=success&perPage=100&page=${page}&from=${from.toISOString()}&to=${to.toISOString()}`
      );
      const batch = r.data || [];
      transactions.push(...batch);
      if (batch.length < 100) break; // last page
    }

    const candidates = transactions.filter(
      (t) => t.metadata?.type === 'storefront_order' && t.metadata?.companyId
    );
    if (!candidates.length) {
      logger.info(`Order reconciliation: ${transactions.length} txns scanned, 0 storefront orders in window`);
      return;
    }

    let created = 0;
    let skipped = 0;
    for (const txn of candidates) {
      try {
        const exists = await Order.exists({ paystackReference: txn.reference });
        if (exists) { skipped += 1; continue; }

        const company = await Company.findById(txn.metadata.companyId);
        if (!company) {
          logger.warn(`Order reconciliation: no BizlyAI company for id ${txn.metadata.companyId} (ref ${txn.reference}) — likely the shared account's other project, skipping`);
          continue;
        }

        // Lazy require avoids a circular require (storefrontController also
        // requires paystack utils indirectly) at module-load time.
        const { fulfilStorefrontOrder } = require('../controllers/storefrontController');
        const order = await fulfilStorefrontOrder(company, txn, { io: global.io });
        created += 1;
        console.log(`Order reconciliation: created missing order ${order.orderNumber} for reference ${txn.reference} (company ${company._id})`);
      } catch (e) {
        logger.error(`Order reconciliation failed for reference ${txn.reference}: ${e.stack || e.message}`);
      }
    }

    if (created > 0) {
      logger.warn(`Order reconciliation: created ${created} missing order(s), ${skipped} already existed (${candidates.length} storefront txns in window)`);
    } else {
      logger.info(`Order reconciliation: ${candidates.length} storefront txns in window, all already had orders`);
    }
  } catch (err) {
    logger.error('Order reconciliation error:', err.stack || err.message);
  }
}

module.exports = { reconcileStorefrontOrders };
