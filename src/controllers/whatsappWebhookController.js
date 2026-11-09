'use strict';

/**
 * Meta's webhook for the official WhatsApp Business Platform. One URL for
 * the whole platform: each payload names the receiving phone_number_id,
 * which tells us which company it belongs to.
 *
 *   GET  /api/v1/webhooks/whatsapp   Meta's one-time verification handshake
 *   POST /api/v1/webhooks/whatsapp   incoming messages + delivery statuses
 *
 * Env: WHATSAPP_VERIFY_TOKEN (any secret string, also typed into the Meta app)
 *      META_APP_SECRET       (App settings → Basic) — signs every POST
 */
const crypto = require('crypto');
const Company = require('../models/Company');
const inbox = require('../services/inbox');
const cloud = require('../services/whatsappCloud');
const logger = require('../utils/logger');

const WA_AI = { floor: 0.15, topK: 3, keywordHandover: true };
const WA_NO_ANSWER = { reply: 'Please hold, connecting you to our team…', handover: true };

// ── Verification handshake ────────────────────────────────────────────────
// Read from the raw URL: express-mongo-sanitize (app.js) strips query keys
// containing dots, which removes Meta's hub.mode / hub.verify_token / hub.challenge.
exports.verify = (req, res) => {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const q = new URLSearchParams(req.originalUrl.split('?')[1] || '');
  if (expected && q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === expected) {
    return res.status(200).type('text/plain').send((q.get('hub.challenge') || '').replace(/[^\w-]/g, ''));
  }
  return res.sendStatus(403);
};

function validSignature(raw, header) {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !raw || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(header.slice(7));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ── What the customer sent, as text for the inbox ─────────────────────────
const MEDIA_LABEL = {
  image: 'Sent a photo', video: 'Sent a video', audio: 'Sent a voice note', document: 'Sent a document',
  sticker: 'Sent a sticker', location: 'Shared a location', contacts: 'Shared a contact',
};

function readMessage(msg) {
  switch (msg.type) {
    case 'text': return { text: msg.text?.body, readable: true };
    case 'button': return { text: msg.button?.text, readable: true };
    case 'interactive': {
      const r = msg.interactive?.button_reply || msg.interactive?.list_reply;
      return { text: r?.title, readable: true };
    }
    case 'reaction': return null; // an emoji on an earlier message — nothing to answer
    default: {
      const label = MEDIA_LABEL[msg.type] || 'Sent a message WhatsApp could not show here';
      const caption = msg[msg.type]?.caption;
      const place = msg.type === 'location' && msg.location
        ? ` (${[msg.location.name, msg.location.address].filter(Boolean).join(', ') || `${msg.location.latitude}, ${msg.location.longitude}`})`
        : '';
      return { text: `[${label}${place}]${caption ? ` ${caption}` : ''}`, readable: false };
    }
  }
}

// ── Duplicate + ordering guards ───────────────────────────────────────────
// Meta retries a webhook it thinks failed, so the same message can arrive
// twice; and two quick messages from one customer must be handled in order.
const seen = new Map(); // wamid -> time
const SEEN_MS = 60 * 60 * 1000;
function firstTime(id) {
  const now = Date.now();
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > SEEN_MS) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}
const queues = new Map(); // companyId:customer -> promise chain
function inOrder(key, task) {
  const next = (queues.get(key) || Promise.resolve()).then(task, task);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

async function handleChange(value) {
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  if (Array.isArray(value.statuses)) {
    for (const s of value.statuses) {
      if (s.status === 'failed') logger.warn(`WhatsApp delivery failed to ${s.recipient_id}: ${s.errors?.[0]?.title || 'unknown'}`);
    }
  }
  if (!Array.isArray(value.messages) || !value.messages.length) return;

  const company = await Company.findOne({ 'whatsappCloud.phoneNumberId': phoneNumberId, 'whatsappCloud.connected': true })
    .select('_id status').lean();
  if (!company) { logger.warn(`WhatsApp webhook for unknown number ${phoneNumberId} — ignored`); return; }
  if (company.status !== 'active') return;

  const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));

  for (const msg of value.messages) {
    if (!msg?.id || !msg.from || !firstTime(msg.id)) continue;
    const read = readMessage(msg);
    if (!read?.text?.trim()) continue;

    // eslint-disable-next-line no-await-in-loop
    await inOrder(`${company._id}:${msg.from}`, async () => {
      cloud.markRead(company._id, msg.id).catch(() => {}); // blue ticks, best effort
      await inbox.receiveMessage({
        companyId: company._id,
        channel: 'whatsapp',
        externalId: msg.from,
        text: read.text,
        name: names[msg.from],
        phone: msg.from,
        meta: { businessPhone: value.metadata.display_phone_number || '', via: 'cloud' },
        ai: WA_AI,
        noAnswer: WA_NO_ANSWER,
        allowAI: read.readable,
      });
    }).catch((err) => logger.error(`WhatsApp webhook message failed: ${err.message}`));
  }
}

// ── Incoming events ───────────────────────────────────────────────────────
exports.receive = (req, res) => {
  if (!validSignature(req.body, req.headers['x-hub-signature-256'])) {
    logger.warn('WhatsApp webhook rejected: bad or missing signature (is META_APP_SECRET set?)');
    return res.sendStatus(401);
  }
  // Answer Meta at once; the AI reply can take a few seconds.
  res.sendStatus(200);

  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return undefined; }
  if (payload?.object !== 'whatsapp_business_account') return undefined;

  (async () => {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        // eslint-disable-next-line no-await-in-loop
        if (change.field === 'messages') await handleChange(change.value);
      }
    }
  })().catch((err) => logger.error(`WhatsApp webhook processing failed: ${err.message}`));
  return undefined;
};

module.exports._test = { readMessage, validSignature, handleChange };
