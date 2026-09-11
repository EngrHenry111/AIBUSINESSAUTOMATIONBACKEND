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

    // Ensure hot-path compound indexes exist (non-blocking on failure)
    require('./src/utils/ensureIndexes')().catch((e) => logger.warn(`ensureIndexes failed: ${e.message}`));

    // Catch up any company that slipped through without a live store
    // (payments configured but storeEnabled false, or a missing storeSlug)
    require('./src/utils/migrations').migrateStoreEnabled().catch((e) => logger.warn(`migrateStoreEnabled failed: ${e.message}`));

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

    // Socket.io handlers
    io.on('connection', (socket) => {
      logger.debug(`Socket connected: ${socket.id}`);

      // Join company room (for broadcasts)
      socket.on('join_company', (companyId) => {
        socket.join(`company:${companyId}`);
      });

      // Join personal room (for direct messages)
      socket.on('join_user', (userId) => {
        socket.join(`user:${userId}`);
        socket.userId = userId;
      });

      // Join AI chat room
      socket.on('join_chat', (chatId) => {
        socket.join(`chat:${chatId}`);
      });

      // ── WhatsApp ──────────────────────────────────────────────────────
      // Team members join their company room to receive:
      //   whatsapp:qr                  — QR code ready to scan
      //   whatsapp:status              — client connected / disconnected / error
      //   whatsapp:handover_needed     — AI escalated a conversation to humans
      //   whatsapp:new_message         — a new message on any conversation
      //   whatsapp:conversation_claimed— a teammate took a conversation
      //   whatsapp:conversation_updated— status changed (resolved / back to AI)
      socket.on('whatsapp:join', (companyId) => {
        if (companyId) socket.join(`company:${companyId}`);
      });

      // Typing indicators
      socket.on('typing:start', ({ toUserId, fromUser }) => {
        socket.to(`user:${toUserId}`).emit('typing:start', fromUser);
      });

      socket.on('typing:stop', ({ toUserId, fromUserId }) => {
        socket.to(`user:${toUserId}`).emit('typing:stop', { fromUserId });
      });

      socket.on('disconnect', () => {
        logger.debug(`Socket disconnected: ${socket.id}`);
        if (socket.userId) {
          io.emit('user:offline', { userId: socket.userId });
        }
      });
    });

    httpServer.listen(PORT, () => {
      logger.info(`🚀 Server running in ${NODE_ENV} on port ${PORT}`);
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