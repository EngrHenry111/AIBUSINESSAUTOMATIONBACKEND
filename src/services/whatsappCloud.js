'use strict';

/**
 * Official WhatsApp Business Platform (Cloud API) — Meta hosts the number,
 * we talk to it over HTTPS. No browser, no QR code, nothing kept on disk.
 *
 * Each company connects its own number: phoneNumberId + wabaId + an access
 * token (a permanent System User token). Incoming messages arrive on one
 * platform-wide webhook (controllers/whatsappWebhookController.js) and are
 * routed to the company by phoneNumberId.
 */
const Company = require('../models/Company');
const logger = require('../utils/logger');

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v25.0'}`;

// Meta error codes worth explaining in plain words.
const FRIENDLY = {
  131047: 'More than 24 hours have passed since this customer last wrote. WhatsApp only allows approved template messages until they write again.',
  131026: 'This number is not on WhatsApp, or cannot receive messages right now.',
  131030: 'This number is not on the test number\'s allowed list. Add it under "Recipient" in your Meta app (test numbers only).',
  190: 'The WhatsApp access token has expired or was revoked. Reconnect WhatsApp with a new token.',
  100: 'Meta rejected the request. Check the Phone Number ID and token.',
  131056: 'Too many messages to this customer in a short time. Try again shortly.',
};

class GraphError extends Error {
  constructor(err, status) {
    super(FRIENDLY[err?.code] || err?.error_user_msg || err?.message || `WhatsApp request failed (${status})`);
    this.code = err?.code;
    this.status = status;
  }
}

async function graph(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new GraphError(data.error, res.status);
  return data;
}

const digits = (phone) => {
  let n = String(phone || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = `234${n.slice(1)}`; // local Nigerian format
  return n;
};

// ── Credentials (cached briefly; a token change takes effect within a minute) ──
const credCache = new Map(); // companyId -> { at, creds }
const CACHE_MS = 60 * 1000;

async function credsFor(companyId) {
  const key = String(companyId);
  const hit = credCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.creds;
  // Never throws: callers include fire-and-forget paths (markRead) where a
  // rejected promise would be an uncaught exception.
  try {
    // Name each field: selecting "whatsappCloud" together with its hidden
    // token is a MongoDB path collision.
    const company = await Company.findById(companyId)
      .select('whatsappCloud.connected whatsappCloud.phoneNumberId whatsappCloud.accessToken').lean();
    const wc = company?.whatsappCloud;
    const creds = wc?.connected && wc.accessToken && wc.phoneNumberId ? { phoneNumberId: wc.phoneNumberId, token: wc.accessToken } : null;
    credCache.set(key, { at: Date.now(), creds });
    return creds;
  } catch (err) {
    logger.error(`WhatsApp Cloud credentials lookup failed (company ${companyId}): ${err.message}`);
    return null;
  }
}
const forget = (companyId) => credCache.delete(String(companyId));

async function isConnected(companyId) {
  return Boolean(await credsFor(companyId));
}

// ── Sending ────────────────────────────────────────────────────────────────
/** Free-form text — allowed within 24h of the customer's last message. */
async function sendText(companyId, to, text) {
  const creds = await credsFor(companyId);
  if (!creds) return { success: false, reason: 'Official WhatsApp is not connected.' };
  try {
    const data = await graph(`${creds.phoneNumberId}/messages`, creds.token, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'text', text: { preview_url: false, body: String(text).slice(0, 4096) } },
    });
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    if (err.code === 190) forget(companyId);
    logger.warn(`WhatsApp Cloud send failed (company ${companyId}): ${err.message}`);
    return { success: false, reason: err.message, code: err.code };
  }
}

/** An approved template — the only thing allowed outside the 24h window. */
async function sendTemplate(companyId, to, name, language = 'en_US') {
  const creds = await credsFor(companyId);
  if (!creds) return { success: false, reason: 'Official WhatsApp is not connected.' };
  try {
    const data = await graph(`${creds.phoneNumberId}/messages`, creds.token, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', to: digits(to), type: 'template', template: { name, language: { code: language } } },
    });
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    return { success: false, reason: err.message, code: err.code };
  }
}

/** Blue ticks on the customer's message — best effort. */
async function markRead(companyId, messageId) {
  try {
    const creds = await credsFor(companyId);
    if (!creds || !messageId) return;
    await graph(`${creds.phoneNumberId}/messages`, creds.token, {
      method: 'POST', body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
    });
  } catch { /* cosmetic only */ }
}

// ── Connecting a number ────────────────────────────────────────────────────
/**
 * Checks the details against Meta and subscribes our app to the account's
 * webhooks, so incoming messages reach us. Throws a GraphError with a
 * readable message when something is wrong.
 */
async function verifyAndSubscribe({ phoneNumberId, wabaId, accessToken }) {
  const number = await graph(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, accessToken);
  await graph(`${wabaId}/subscribed_apps`, accessToken, { method: 'POST' });
  return {
    displayPhone: number.display_phone_number || '',
    verifiedName: number.verified_name || '',
    qualityRating: number.quality_rating || '',
  };
}

module.exports = { sendText, sendTemplate, markRead, verifyAndSubscribe, isConnected, credsFor, forget, digits, GraphError };
