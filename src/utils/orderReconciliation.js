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
// `options.from`/`options.to` let a one-off backfill scan much further back
// than the 15-minute job's default 3-hour rolling window — e.g. to recover
// orders paid before this reconciliation job even existed. See
// POST /admin/reconcile-orders?days=90 for how that's triggered.
async function reconcileStorefrontOrders(options = {}) {
  const to = options.to || new Date();
  const from = options.from || new Date(to.getTime() - LOOKBACK_MS);
  const maxPages = options.maxPages || MAX_PAGES;
  const summary = { scanned: 0, candidates: 0, created: 0, skipped: 0, createdOrders: [], errors: [] };

  try {
    const transactions = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const r = await paystackAPI(
        'GET',
        `/transaction?status=success&perPage=100&page=${page}&from=${from.toISOString()}&to=${to.toISOString()}`
      );
      const batch = r.data || [];
      transactions.push(...batch);
      if (batch.length < 100) break; // last page
    }
    summary.scanned = transactions.length;

    const candidates = transactions.filter(
      (t) => t.metadata?.type === 'storefront_order' && t.metadata?.companyId
    );
    summary.candidates = candidates.length;
    if (!candidates.length) {
      logger.info(`Order reconciliation: ${transactions.length} txns scanned (${from.toISOString()} → ${to.toISOString()}), 0 storefront orders`);
      return summary;
    }

    for (const txn of candidates) {
      try {
        const exists = await Order.exists({ paystackReference: txn.reference });
        if (exists) { summary.skipped += 1; continue; }

        const company = await Company.findById(txn.metadata.companyId);
        if (!company) {
          logger.warn(`Order reconciliation: no BizlyAI company for id ${txn.metadata.companyId} (ref ${txn.reference}) — likely the shared account's other project, skipping`);
          continue;
        }

        // Lazy require avoids a circular require (storefrontController also
        // requires paystack utils indirectly) at module-load time.
        const { fulfilStorefrontOrder } = require('../controllers/storefrontController');
        const order = await fulfilStorefrontOrder(company, txn, { io: global.io });
        summary.created += 1;
        summary.createdOrders.push({ orderNumber: order.orderNumber, reference: txn.reference, companyId: String(company._id), total: order.total });
        console.log(`Order reconciliation: created missing order ${order.orderNumber} for reference ${txn.reference} (company ${company._id})`);
      } catch (e) {
        summary.errors.push({ reference: txn.reference, message: e.message });
        logger.error(`Order reconciliation failed for reference ${txn.reference}: ${e.stack || e.message}`);
      }
    }

    if (summary.created > 0) {
      logger.warn(`Order reconciliation: created ${summary.created} missing order(s), ${summary.skipped} already existed (${candidates.length} storefront txns, window ${from.toISOString()} → ${to.toISOString()})`);
    } else {
      logger.info(`Order reconciliation: ${candidates.length} storefront txns in window, all already had orders`);
    }
    return summary;
  } catch (err) {
    logger.error('Order reconciliation error:', err.stack || err.message);
    summary.errors.push({ reference: null, message: err.message });
    return summary;
  }
}

module.exports = { reconcileStorefrontOrders };
