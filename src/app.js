'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const path = require('path');

require('./config/passport');

const { generalLimiter, uploadLimiter } = require('./middleware/rateLimitMiddleware');
const { checkIpBlocked, trackRequestRate } = require('./utils/suspiciousActivity');
const errorMiddleware = require('./middleware/errorMiddleware');
const logger = require('./utils/logger');

// Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const companyRoutes = require('./routes/companyRoutes');
const documentRoutes = require('./routes/documentRoutes');
const chatRoutes = require('./routes/chatRoutes');
const leadRoutes = require('./routes/leadRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const orderRoutes = require('./routes/orderRoutes');
const productRoutes = require('./routes/productRoutes');
const customerRoutes = require('./routes/customerRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const reportRoutes = require('./routes/reportRoutes');
const socialRoutes = require('./routes/socialRoutes');
const agentRoutes = require('./routes/agentRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const knowledgeBaseRoutes = require('./routes/knowledgeBaseRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const messageRoutes = require('./routes/messageRoutes');
const searchRoutes = require('./routes/searchRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const paymentSettingsRoutes = require('./routes/paymentSettingsRoutes');
const storefrontRoutes = require('./routes/storefrontRoutes');
const widgetRoutes = require('./routes/widgetRoutes');
const payrollRoutes = require('./routes/payrollRoutes');
const cardRoutes = require('./routes/cardRoutes');
const loyaltyRoutes = require('./routes/loyaltyRoutes');
const currencyRoutes = require('./routes/currencyRoutes');
const contractRoutes = require('./routes/contractRoutes');
const procurementRoutes = require('./routes/procurementRoutes');
const giftCardRoutes = require('./routes/giftCardRoutes');
const couponRoutes = require('./routes/couponRoutes');
const marketplaceRoutes = require('./routes/marketplaceRoutes');
const portalRoutes = require('./routes/portalRoutes');
const twoFactorRoutes = require('./routes/twoFactorRoutes');
const auditRoutes = require('./routes/auditRoutes');


const app = express();

// ─── Proxy Trust ─────────────────────────────────────────────────────────────
// Render / Vercel / any host that terminates TLS in front of us. Required for
// secure cookies, correct req.ip (rate limiting), and req.protocol.
app.set('trust proxy', 1);

// ─── Security Headers ────────────────────────────────────────────────────────
// This is a pure JSON API (the SPA is served by Vercel) so a CSP here mostly
// protects the rare error page / static asset, but automated security scans
// (and enterprise vendor questionnaires) check for its presence regardless —
// a locked-down default costs nothing since no HTML is rendered from here.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // A few routes (invoice / meeting-minutes PDF export) return real,
      // inline-styled HTML with a Cloudinary-hosted logo, opened directly in
      // a browser tab — defaultSrc 'none' would blank those out. Scripts and
      // framing (the actual XSS/clickjacking surface) stay fully locked down.
      defaultSrc: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'https:', 'data:'],
      scriptSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: { action: 'deny' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));
// Legacy header modern browsers ignore (and helmet deliberately omits since
// v4), but enterprise security checklists still ask for it verbatim.
app.use((req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ─── CORS ────────────────────────────────────────────────────────────────────
// Explicit allow-list from CLIENT_URL (comma-separated), normalised without a
// trailing slash, plus pattern matches for localhost, any bislyai.com host, and
// Vercel preview deployments.
const staticOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const originPatterns = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https:\/\/([a-z0-9-]+\.)*bislyai\.com$/,
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/,
];

const isAllowedOrigin = (origin) => {
  const clean = origin.replace(/\/+$/, '');
  return staticOrigins.includes(clean) || originPatterns.some((re) => re.test(clean));
};

const corsOptions = {
  origin: (origin, callback) => {
    // No Origin header => same-origin or a non-browser client (curl, health checks).
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    logger.warn(`CORS blocked origin: ${origin}`);
    // Return false (not an Error) so the response is a clean request without
    // CORS headers instead of a 500 from the error handler.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Refresh-Token'],
};

// The embeddable chat widget's public endpoints are the one deliberate
// exception to the allow-list above: the entire feature is that a client
// pastes a <script> tag on THEIR OWN website (any domain, not bislyai.com),
// so these routes must accept requests from anywhere. No cookies/credentials
// ever travel on them (anonymous visitors are tracked by a client-generated
// sessionId, not auth), so an open origin is safe here.
const isPublicWidgetPath = (req) => /^\/api\/v1\/widget\/[^/]+\/(config|message|history)(\/|$)/.test(req.path);
app.use((req, res, next) => {
  if (!isPublicWidgetPath(req)) return next();
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => (isPublicWidgetPath(req) ? next() : cors(corsOptions)(req, res, next)));
app.options('*', (req, res, next) => (isPublicWidgetPath(req) ? res.sendStatus(204) : cors(corsOptions)(req, res, next))); // ensure preflight is answered for every route

// ─── Abuse detection ─────────────────────────────────────────────────────────
// After CORS so a blocked client still gets a readable JSON 403 instead of an
// opaque CORS failure. Reject already-blocked IPs before any real work, and
// log request bursts that stay under the hard rate-limit caps below.
app.use(checkIpBlocked);
app.use(trackRequestRate);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// The Paystack webhook needs its raw body for signature verification, so skip
// the JSON parser for that one route (it uses express.raw in its router).
const jsonParser = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/v1/payments/webhook')) return next();
  return jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── Passport (stateless — no sessions) ──────────────────────────────────────
app.use(passport.initialize());

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression());

// ─── Static: user avatars (fallback when Cloudinary isn't configured) ────────
app.use('/uploads/avatars', express.static(path.join(process.cwd(), 'uploads', 'avatars'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

// ─── Request Sanitization ─────────────────────────────────────────────────────
app.use(mongoSanitize());
app.use(xss());

// ─── Request Logging ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.path === '/health',
  }));
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────
app.use('/api', generalLimiter);
app.use('/api/v1/documents/upload', uploadLimiter);
// authLimiter is applied per-route inside authRoutes (login / register / password
// reset only) so that /auth/me and /auth/refresh-token stay unthrottled.

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  });
});

// ─── API Routes ──────────────────────────────────────────────────────────────
const API = '/api/v1';

app.use(`${API}/auth`, authRoutes);
app.use(API, twoFactorRoutes); // /2fa/* and /auth/2fa/*
app.use(`${API}/users`, userRoutes);
app.use(`${API}/companies`, companyRoutes);
app.use(`${API}/documents`, documentRoutes);
app.use(`${API}/knowledge-bases`, knowledgeBaseRoutes);
app.use(`${API}/chat`, chatRoutes);
app.use(`${API}/leads`, leadRoutes);
app.use(`${API}/meetings`, meetingRoutes);
app.use(`${API}/invoices`, invoiceRoutes);
app.use(`${API}/orders`, orderRoutes);
app.use(`${API}/products`, productRoutes);
app.use(`${API}/customers`, customerRoutes);
app.use(`${API}/expenses`, expenseRoutes);
app.use(`${API}/appointments`, appointmentRoutes);
app.use(`${API}/reports`, reportRoutes);
app.use(`${API}/social`, socialRoutes);
app.use(`${API}/agents`, agentRoutes);
app.use(`${API}/analytics`, analyticsRoutes);
app.use(`${API}/admin`, adminRoutes);
app.use(`${API}/whatsapp`, whatsappRoutes);
app.use(`${API}/payments`, paymentRoutes);
app.use(`${API}/payment-settings`, paymentSettingsRoutes);
app.use(`${API}/store`, storefrontRoutes);
app.use(`${API}/widget`, widgetRoutes);
app.use(`${API}/payroll`, payrollRoutes);
app.use(`${API}/card`, cardRoutes);
app.use(`${API}/loyalty`, loyaltyRoutes);
app.use(`${API}/currency`, currencyRoutes);
app.use(`${API}/contracts`, contractRoutes);
app.use(`${API}/procurement`, procurementRoutes);
app.use(`${API}/gift-cards`, giftCardRoutes);
app.use(`${API}/coupons`, couponRoutes);
app.use(`${API}/marketplace`, marketplaceRoutes);
app.use(`${API}/messages`, messageRoutes);
app.use(`${API}/search`, searchRoutes);
app.use(`${API}/notifications`, notificationRoutes);
app.use(`${API}/portal`, portalRoutes);
app.use(`${API}/audit-logs`, auditRoutes);


// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use(errorMiddleware);

module.exports = app;
