'use strict';

require('dotenv').config();

const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const logger = require('./src/utils/logger');

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

async function bootstrap() {
  try {
    await connectDB();
    logger.info('✅ MongoDB connected');

    // Test email configuration on startup
    require('./src/services/emailService');
    logger.info('Email config check:');
    logger.info('RESEND_API_KEY set: ' + !!process.env.RESEND_API_KEY);
    logger.info('EMAIL_FROM: ' + process.env.EMAIL_FROM);

    // Ensure hot-path compound indexes exist (non-blocking on failure)
    require('./src/utils/ensureIndexes')().catch((e) => logger.warn(`ensureIndexes failed: ${e.message}`));

    // Catch up any company that slipped through without a live store
    // (payments configured but storeEnabled false, or a missing storeSlug)
    require('./src/utils/migrations').migrateStoreEnabled().catch((e) => logger.warn(`migrateStoreEnabled failed: ${e.message}`));
    require('./src/utils/migrations').purgeDemoGroupData().catch((e) => logger.warn(`purgeDemoGroupData failed: ${e.message}`));

    const httpServer = http.createServer(app);

    const io = new SocketIOServer(httpServer, {
      cors: {
        origin: (process.env.CLIENT_URL || 'http://localhost:5173')
          .split(',')
          .map((o) => o.trim().replace(/\/+$/, '')),
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    app.set('io', io);
    global.io = io; // fallback for code paths without req.app access

    // Let the WhatsApp service emit real-time events (QR, handovers, messages)
    require('./src/services/whatsappService').setIo(io);

    // ── Daily subscription expiry checker ─────────────────────────────────
    const { startKeepAlive } = require('./src/utils/keepAlive');
    startKeepAlive();

    const { checkSubscriptions } = require('./src/utils/subscriptionChecker');

    // Run immediately on startup
    checkSubscriptions();

    // Then run every 24 hours
    setInterval(checkSubscriptions, 24 * 60 * 60 * 1000);
    logger.info('✅ Subscription checker scheduled (runs every 24h)');

    // ── Auto-verify accounts that never clicked their verification link ───
    const { autoVerifyOldAccounts } = require('./src/utils/accountVerification');
    autoVerifyOldAccounts();
    setInterval(autoVerifyOldAccounts, 24 * 60 * 60 * 1000);
    logger.info('✅ Auto email-verification checker scheduled (runs every 24h)');

    // ── Meeting reminders (24h-before / 1h-before) ─────────────────────────
    const { checkMeetingReminders } = require('./src/utils/meetingReminders');
    checkMeetingReminders();
    setInterval(checkMeetingReminders, 30 * 60 * 1000);
    logger.info('✅ Meeting reminder checker scheduled (runs every 30min)');

    // ── Legal matters — hearing / deadline / limitation reminders ──────────
    const { runDueGroupDigests } = require('./src/utils/groupDigest');
    setTimeout(runDueGroupDigests, 60 * 1000);
    setInterval(runDueGroupDigests, 5 * 60 * 1000);
    logger.info('✅ Nightly group summary checker scheduled (runs every 5min)');
    const { runDueMonthlyReports } = require('./src/utils/groupDigest');
    setTimeout(runDueMonthlyReports, 2 * 60 * 1000);
    setInterval(runDueMonthlyReports, 60 * 60 * 1000);
    const { runCreditReminders } = require('./src/utils/groupCredit');
    setTimeout(runCreditReminders, 3 * 60 * 1000);
    setInterval(runCreditReminders, 6 * 60 * 60 * 1000);
    logger.info('✅ Monthly group report + credit reminders scheduled');
    const { runEnterpriseRenewalReminders } = require('./src/utils/enterpriseRenewals');
    setTimeout(runEnterpriseRenewalReminders, 4 * 60 * 1000);
    setInterval(runEnterpriseRenewalReminders, 6 * 60 * 60 * 1000);

    const { checkMatterReminders } = require('./src/utils/matterReminders');
    checkMatterReminders();
    setInterval(checkMatterReminders, 60 * 60 * 1000);
    logger.info('✅ Matter key-date reminder checker scheduled (runs hourly)');

    // ── School fee reminders to parents (acts at 9am Lagos, checked hourly) ─
    const { runAutomaticFeeReminders } = require('./src/utils/schoolFeeReminders');
    setInterval(() => runAutomaticFeeReminders(app.get('io')), 60 * 60 * 1000);
    logger.info('✅ School fee reminder checker scheduled (daily at 9am, checked hourly)');

    // ── Overdue invoice reminders (email + SMS) ────────────────────────────
    const { checkOverdueInvoices } = require('./src/utils/invoiceReminders');
    checkOverdueInvoices();
    setInterval(checkOverdueInvoices, 24 * 60 * 60 * 1000);
    logger.info('✅ Overdue invoice reminder checker scheduled (runs every 24h)');

    // ── Recurring invoices — generate + send due occurrences daily at 8am ──
    // Checked hourly rather than via a fixed 24h interval so it actually
    // fires at a predictable time of day instead of drifting to whatever
    // minute the server happened to boot at.
    const { processRecurringInvoices } = require('./src/utils/recurringInvoices');
    processRecurringInvoices().catch((e) => logger.error(`processRecurringInvoices (startup) failed: ${e.message}`));
    setInterval(() => {
      if (new Date().getHours() === 8) {
        processRecurringInvoices().catch((e) => logger.error(`processRecurringInvoices failed: ${e.message}`));
      }
    }, 60 * 60 * 1000);
    logger.info('✅ Recurring invoice processor scheduled (runs daily at 8am, checked hourly)');

    // ── Loyalty points expiry — sweep stale points daily at 3am ─────────────
    const { expireOldPoints } = require('./src/utils/loyaltyPoints');
    expireOldPoints().catch((e) => logger.error(`expireOldPoints (startup) failed: ${e.message}`));
    setInterval(() => {
      if (new Date().getHours() === 3) {
        expireOldPoints().catch((e) => logger.error(`expireOldPoints failed: ${e.message}`));
      }
    }, 60 * 60 * 1000);
    logger.info('✅ Loyalty points expiry sweep scheduled (runs daily at 3am, checked hourly)');

    // ── Scheduled gift card delivery — checked hourly ───────────────────────
    const { sendScheduledGiftCards } = require('./src/controllers/giftCardController');
    sendScheduledGiftCards();
    setInterval(sendScheduledGiftCards, 60 * 60 * 1000);
    logger.info('✅ Scheduled gift card delivery checker scheduled (runs hourly)');

    // ── Abandoned cart recovery emails — checked hourly ─────────────────────
    const { checkAbandonedCarts } = require('./src/utils/abandonedCartReminders');
    checkAbandonedCarts();
    setInterval(checkAbandonedCarts, 60 * 60 * 1000);
    logger.info('✅ Abandoned cart reminder checker scheduled (runs hourly)');

    // ── Store subscriptions — recurring deliveries, daily at 6am ────────────
    const { processStoreSubscriptions } = require('./src/utils/storeSubscriptionProcessor');
    processStoreSubscriptions().catch((e) => logger.error(`processStoreSubscriptions (startup) failed: ${e.message}`));
    setInterval(() => {
      if (new Date().getHours() === 6) {
        processStoreSubscriptions().catch((e) => logger.error(`processStoreSubscriptions failed: ${e.message}`));
      }
    }, 60 * 60 * 1000);
    logger.info('✅ Store subscription processor scheduled (runs daily at 6am, checked hourly)');

    // ── Group buys — settle expired deals (success or refund), checked hourly ──
    const { checkExpiredGroupBuys } = require('./src/controllers/groupBuyController');
    checkExpiredGroupBuys();
    setInterval(checkExpiredGroupBuys, 60 * 60 * 1000);
    logger.info('✅ Group buy expiry checker scheduled (runs hourly)');

    // ── Storefront order reconciliation (safety net) ───────────────────────
    // Catches any order the webhook AND the customer-return path both missed
    // by asking Paystack directly for recent successful transactions.
    const { reconcileStorefrontOrders } = require('./src/utils/orderReconciliation');
    reconcileStorefrontOrders();
    setInterval(reconcileStorefrontOrders, 15 * 60 * 1000);
    logger.info('✅ Storefront order reconciliation scheduled (runs every 15min)');

    // ── Leads: follow-up reminders (hourly) + one-off phone key backfill ──
    const { runLeadFollowUps } = require('./src/utils/leadFollowUps');
    require('./src/utils/leadCapture').backfillPhoneKeys();
    runLeadFollowUps();
    setInterval(runLeadFollowUps, 60 * 60 * 1000);
    logger.info('✅ Lead follow-up reminders scheduled (runs hourly)');

    // Socket.io: authenticated rooms (see utils/socketAuth.js)
    require('./src/utils/socketAuth').attachSocketHandlers(io);

    httpServer.listen(PORT, () => {
      logger.info(`🚀 Server running in ${NODE_ENV} on port ${PORT}`);
      const { isProd } = require('./src/utils/generateTokens');
      logger.info(`🍪 Auth cookies: ${isProd() ? 'SameSite=None; Secure (cross-site mode)' : 'SameSite=Lax (dev mode)'} — NODE_ENV=${process.env.NODE_ENV || '(unset)'} RENDER=${process.env.RENDER || '(unset)'}`);
      logger.info(`🔗 API: http://localhost:${PORT}/api/v1`);
    });

    const shutdown = (signal) => {
      logger.warn(`⚠️  ${signal} received. Shutting down...`);
      httpServer.close(async () => {
        const mongoose = require('mongoose');
        await mongoose.connection.close(false);
        logger.info('✅ Shutdown complete');
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      // Log but don't shut down — async errors (e.g. failed uploads) shouldn't kill the server
      logger.error('Unhandled rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception:', err);
      // Only shut down on truly fatal errors, not operational ones
      if (err.code === 'ERR_USE_AFTER_CLOSE' || err.code === 'EADDRINUSE') {
        shutdown('uncaughtException');
      }
    });

  } catch (err) {
    logger.error('Bootstrap failed:', err);
    process.exit(1);
  }
}

bootstrap();