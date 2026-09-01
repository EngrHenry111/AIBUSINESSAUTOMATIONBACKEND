'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const cookieParser = require('cookie-parser');
const path = require('path');

const { generalLimiter, authLimiter, uploadLimiter } = require('./middleware/rateLimitMiddleware');
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
const appointmentRoutes = require('./routes/appointmentRoutes');
const reportRoutes = require('./routes/reportRoutes');
const socialRoutes = require('./routes/socialRoutes');
const agentRoutes = require('./routes/agentRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const knowledgeBaseRoutes = require('./routes/knowledgeBaseRoutes');
// const whatsappRoutes = require('./routes/whatsappRoutes');
const messageRoutes = require('./routes/messageRoutes');
const searchRoutes = require('./routes/searchRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const paymentRoutes = require('./routes/paymentRoutes');


const app = express();

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Refresh-Token'],
}));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression());

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
app.use('/api/auth', authLimiter);
app.use('/api/documents/upload', uploadLimiter);

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
app.use(`${API}/users`, userRoutes);
app.use(`${API}/companies`, companyRoutes);
app.use(`${API}/documents`, documentRoutes);
app.use(`${API}/knowledge-bases`, knowledgeBaseRoutes);
app.use(`${API}/chat`, chatRoutes);
app.use(`${API}/leads`, leadRoutes);
app.use(`${API}/meetings`, meetingRoutes);
app.use(`${API}/invoices`, invoiceRoutes);
app.use(`${API}/orders`, orderRoutes);
app.use(`${API}/appointments`, appointmentRoutes);
app.use(`${API}/reports`, reportRoutes);
app.use(`${API}/social`, socialRoutes);
app.use(`${API}/agents`, agentRoutes);
app.use(`${API}/analytics`, analyticsRoutes);
app.use(`${API}/admin`, adminRoutes);
// app.use('/api/v1/whatsapp', whatsappRoutes);
app.use(`${API}/payments`, paymentRoutes);
app.use(`${API}/messages`, messageRoutes);


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
