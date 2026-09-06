'use strict';

/**
 * Per-company WhatsApp integration (whatsapp-web.js).
 *
 * Each company scans its own QR and gets its own client + LocalAuth session
 * stored in ./whatsapp-sessions/company-<id>/. Incoming customer messages are
 * either answered by the AI (knowledge-base grounded) or escalated to a human.
 *
 * NOTE: whatsapp-web.js drives a headless Chromium via puppeteer, so this only
 * runs where Chrome can launch (local dev, a Linux VPS) — not on Render.
 * Every entry point degrades gracefully when a client can't start.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const WhatsAppConversation = require('../models/WhatsAppConversation');
const DocumentChunk = require('../models/DocumentChunk');
const { getEmbedding } = require('./embeddingService');
const { hybridSearch, rerankChunks } = require('../utils/hybridSearch');
const { generateWhatsAppReply } = require('./groqService');

const SESSION_ROOT = path.join(process.cwd(), 'whatsapp-sessions');
const AI_CONFIDENCE_FLOOR = 0.15;
const HANDOVER_KEYWORDS = [
  'human', 'agent', 'real person', 'person', 'representative', 'rep',
  'speak to someone', 'talk to someone', 'talk to a human', 'customer service',
];

// companyId(string) -> { client, status, qr, qrBase64, phone, error }
const sessions = new Map();
let ioRef = null;

function setIo(io) { if (io) ioRef = io; }

function roomEmit(companyId, event, payload) {
  if (ioRef) ioRef.to(`company:${companyId}`).emit(event, payload);
}
function userEmit(userId, event, payload) {
  if (ioRef && userId) ioRef.to(`user:${userId}`).emit(event, payload);
}

// ── Status ────────────────────────────────────────────────────────────────
function getStatus(companyId) {
  const s = sessions.get(String(companyId));
  if (!s) return { status: 'disconnected', qr: null, phone: null };
  return { status: s.status, qr: s.qrBase64 || null, phone: s.phone || null, error: s.error || null };
}

// ── Phone formatting ──────────────────────────────────────────────────────
function formatNumber(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.startsWith('0')) num = '234' + num.slice(1);       // default Nigeria
  return num.includes('@') ? num : `${num}@c.us`;
}

// ── Initialize a company's client ─────────────────────────────────────────
function initialize(companyId, io) {
  setIo(io);
  const key = String(companyId);
  const existing = sessions.get(key);
  if (existing && ['connecting', 'qr_ready', 'connected'].includes(existing.status)) {
    return getStatus(companyId);
  }

  let Client, LocalAuth;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
  } catch (err) {
    logger.error('whatsapp-web.js not available:', err.message);
    sessions.set(key, { status: 'error', error: 'WhatsApp library unavailable on this host.' });
    return getStatus(companyId);
  }

  try { fs.mkdirSync(SESSION_ROOT, { recursive: true }); } catch { /* ignore */ }

  logger.info(`Initializing WhatsApp client for company ${key}…`);
  const session = { client: null, status: 'connecting', qr: null, qrBase64: null, phone: null, error: null };
  sessions.set(key, session);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `company-${key}`, dataPath: SESSION_ROOT }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu',
      ],
    },
  });
  session.client = client;

  client.on('qr', async (qr) => {
    session.status = 'qr_ready';
    session.qr = qr;
    try {
      const QRCode = require('qrcode');
      session.qrBase64 = await QRCode.toDataURL(qr);
    } catch {
      session.qrBase64 = null;
    }
    logger.info(`WhatsApp QR ready for company ${key}`);
    roomEmit(companyId, 'whatsapp:qr', { companyId: key, qr: session.qrBase64 || qr, status: 'qr_ready' });
  });

  client.on('authenticated', () => logger.info(`WhatsApp authenticated for company ${key}`));

  client.on('ready', () => {
    session.status = 'connected';
    session.qr = null;
    session.qrBase64 = null;
    session.phone = client.info?.wid?.user || null;
    logger.info(`✅ WhatsApp connected for company ${key} (${session.phone})`);
    roomEmit(companyId, 'whatsapp:status', { companyId: key, status: 'connected', phone: session.phone });
  });

  client.on('auth_failure', (msg) => {
    session.status = 'error';
    session.error = 'Authentication failed. Please reconnect.';
    logger.error(`WhatsApp auth failure for company ${key}: ${msg}`);
    roomEmit(companyId, 'whatsapp:status', { companyId: key, status: 'error', error: session.error });
  });

  client.on('disconnected', (reason) => {
    logger.warn(`WhatsApp disconnected for company ${key}: ${reason}`);
    sessions.delete(key);
    roomEmit(companyId, 'whatsapp:status', { companyId: key, status: 'disconnected' });
  });

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || !msg.from || !msg.from.endsWith('@c.us')) return; // ignore groups / status / self
      const text = (msg.body || '').trim();
      if (!text) return;
      const customerPhone = msg.from.replace('@c.us', '');
      let customerName = customerPhone;
      try {
        const contact = await msg.getContact();
        customerName = contact?.pushname || contact?.name || msg._data?.notifyName || customerPhone;
      } catch { /* keep phone as name */ }
      await handleIncomingMessage(companyId, customerPhone, customerName, text);
    } catch (err) {
      logger.error('WhatsApp message handler error:', err.message);
    }
  });

  client.initialize().catch((err) => {
    session.status = 'error';
    session.error = `Could not start WhatsApp: ${err.message}`;
    logger.error(`WhatsApp init failed for company ${key}: ${err.message}`);
    roomEmit(companyId, 'whatsapp:status', { companyId: key, status: 'error', error: session.error });
  });

  return getStatus(companyId);
}

async function disconnect(companyId) {
  const key = String(companyId);
  const session = sessions.get(key);
  if (session?.client) {
    try { await session.client.destroy(); } catch { /* ignore */ }
  }
  sessions.delete(key);
  roomEmit(companyId, 'whatsapp:status', { companyId: key, status: 'disconnected' });
}

// ── Outbound ──────────────────────────────────────────────────────────────
async function sendToCustomer(companyId, phone, message) {
  const session = sessions.get(String(companyId));
  if (!session?.client || session.status !== 'connected') {
    logger.warn(`WhatsApp not connected for company ${companyId} — cannot send to ${phone}`);
    return { success: false, reason: 'WhatsApp is not connected.' };
  }
  try {
    await session.client.sendMessage(formatNumber(phone), message);
    return { success: true };
  } catch (err) {
    logger.error(`WhatsApp send failed to ${phone}: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ── Inbound customer message ──────────────────────────────────────────────
async function handleIncomingMessage(companyId, customerPhone, customerName, messageText) {
  const session = sessions.get(String(companyId));

  let convo = await WhatsAppConversation.findOne({
    companyId, customerPhone, status: { $ne: 'resolved' },
  }).sort({ lastMessageAt: -1 });

  if (!convo) {
    convo = await WhatsAppConversation.create({
      companyId,
      businessPhone: session?.phone || '',
      customerPhone,
      customerName,
      status: 'ai',
      messages: [],
      lastMessageAt: new Date(),
    });
  }
  if (!convo.customerName || convo.customerName === convo.customerPhone) {
    convo.customerName = customerName;
  }

  convo.messages.push({ from: 'customer', content: messageText, timestamp: new Date(), read: false });
  convo.lastMessageAt = new Date();
  await convo.save();

  const inbound = convo.messages[convo.messages.length - 1];
  roomEmit(companyId, 'whatsapp:new_message', {
    conversationId: convo._id, message: inbound, customerName: convo.customerName, status: convo.status,
  });

  // ── Human is handling this thread ──────────────────────────────────────
  if (convo.status === 'human_takeover') {
    if (convo.assignedTo) {
      userEmit(convo.assignedTo, 'whatsapp:new_message', { conversationId: convo._id, message: inbound });
    } else {
      roomEmit(companyId, 'whatsapp:handover_needed', {
        conversationId: convo._id, customerName: convo.customerName,
        customerPhone: convo.customerPhone, lastMessage: messageText,
      });
    }
    return;
  }

  // ── AI flow ───────────────────────────────────────────────────────────
  const lower = messageText.toLowerCase();
  const keywordHit = HANDOVER_KEYWORDS.some((k) => lower.includes(k));

  const chunks = await DocumentChunk.find({ companyId }).lean();

  let embedding = null;
  try { embedding = await getEmbedding(messageText); }
  catch { logger.warn('Embedding service down — WhatsApp AI using keyword search only'); }

  const ranked = rerankChunks(hybridSearch(chunks, embedding, messageText, { topK: 3 }), messageText);
  const topScore = ranked[0]?.rerankScore || 0;

  if (keywordHit || chunks.length === 0 || topScore < AI_CONFIDENCE_FLOOR) {
    await triggerHumanHandover(convo, companyId);
    return;
  }

  const context = ranked.slice(0, 3).map((r) => r.chunk).join('\n\n---\n\n');
  const history = convo.messages
    .slice(-9, -1)
    .filter((m) => m.from === 'customer' || m.from === 'ai')
    .map((m) => ({ role: m.from === 'customer' ? 'user' : 'assistant', content: m.content }));

  let reply;
  try {
    reply = await generateWhatsAppReply(context, messageText, history);
  } catch (err) {
    logger.error('WhatsApp AI reply failed:', err.message);
    await triggerHumanHandover(convo, companyId);
    return;
  }

  await sendToCustomer(companyId, customerPhone, reply);
  convo.messages.push({ from: 'ai', content: reply, timestamp: new Date(), agentName: 'AI Assistant', read: true });
  convo.status = 'ai';
  convo.lastMessageAt = new Date();
  await convo.save();

  roomEmit(companyId, 'whatsapp:new_message', {
    conversationId: convo._id, message: convo.messages[convo.messages.length - 1], status: 'ai',
  });
}

// ── Escalate to a human ───────────────────────────────────────────────────
async function triggerHumanHandover(convo, companyId) {
  convo.status = 'human_takeover';
  convo.assignedTo = null;
  convo.handoverRequestedAt = new Date();
  convo.messages.push({
    from: 'system', content: 'Conversation escalated to a human agent', timestamp: new Date(), read: true,
  });
  convo.lastMessageAt = new Date();
  await convo.save();

  await sendToCustomer(companyId, convo.customerPhone, 'Please hold, connecting you to our team…');

  const lastCustomer = [...convo.messages].reverse().find((m) => m.from === 'customer');
  roomEmit(companyId, 'whatsapp:handover_needed', {
    conversationId: convo._id,
    customerName: convo.customerName,
    customerPhone: convo.customerPhone,
    lastMessage: lastCustomer?.content || '',
    handoverRequestedAt: convo.handoverRequestedAt,
  });
}

module.exports = {
  setIo,
  getStatus,
  initialize,
  disconnect,
  sendToCustomer,
  handleIncomingMessage,
  triggerHumanHandover,
  roomEmit,
  userEmit,
};
