'use strict';

/**
 * Telegram's webhook. Each business's bot posts to its own URL,
 *   POST /api/v1/webhooks/telegram/:companyId
 * with the secret we gave Telegram in X-Telegram-Bot-Api-Secret-Token.
 * Only private chats are answered (a bot added to a group is ignored).
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const inbox = require('../services/inbox');
const tg = require('../services/telegram');
const logger = require('../utils/logger');

const TG_AI = { floor: 0.15, topK: 3, keywordHandover: true };
const TG_NO_ANSWER = { reply: 'Please hold, connecting you to our team…', handover: true };

function sameSecret(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── What the customer sent, as text for the inbox ─────────────────────────
const MEDIA = [
  ['photo', 'Sent a photo'], ['video', 'Sent a video'], ['video_note', 'Sent a video message'],
  ['voice', 'Sent a voice note'], ['audio', 'Sent an audio file'], ['document', 'Sent a document'],
  ['sticker', 'Sent a sticker'], ['animation', 'Sent a GIF'], ['poll', 'Sent a poll'],
];

/** @returns {{text, readable, phone?}|null} */
function readMessage(msg) {
  if (typeof msg.text === 'string') {
    const t = msg.text.trim();
    // Pressing START sends "/start" (sometimes "/start <campaign>"): a hello.
    if (/^\/start(@\w+)?(\s|$)/i.test(t)) return { text: 'Hi', readable: true };
    return { text: t, readable: true };
  }
  if (msg.contact) {
    const c = msg.contact;
    // Their own number, from the "Share my phone number" button.
    if (c.user_id && msg.from && c.user_id === msg.from.id) {
      return { text: `My phone number is ${c.phone_number}`, readable: true, phone: c.phone_number };
    }
    const who = [c.first_name, c.last_name].filter(Boolean).join(' ');
    return { text: `[Shared a contact: ${who}${c.phone_number ? ` ${c.phone_number}` : ''}]`, readable: false };
  }
  if (msg.location || msg.venue) {
    const v = msg.venue;
    const where = v ? [v.title, v.address].filter(Boolean).join(', ') : `${msg.location.latitude}, ${msg.location.longitude}`;
    return { text: `[Shared a location (${where})]`, readable: false };
  }
  const kind = MEDIA.find(([k]) => msg[k]);
  if (kind) {
    const extra = kind[0] === 'sticker' && msg.sticker?.emoji ? ` ${msg.sticker.emoji}` : '';
    return { text: `[${kind[1]}${extra}]${msg.caption ? ` ${msg.caption}` : ''}`, readable: false };
  }
  return null; // service messages (pinned, member joined, …)
}

// ── Duplicate + ordering guards ───────────────────────────────────────────
// Telegram retries an update until we answer 200, and two quick messages
// from one customer must be handled in order.
const seen = new Map();
const SEEN_MS = 60 * 60 * 1000;
function firstTime(id) {
  const now = Date.now();
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > SEEN_MS) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}
const queues = new Map();
function inOrder(key, task) {
  const next = (queues.get(key) || Promise.resolve()).then(task, task);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

async function handleUpdate(companyId, creds, update) {
  const msg = update?.message;
  if (!msg?.chat || msg.chat.type !== 'private' || msg.from?.is_bot) return;
  if (!firstTime(`${companyId}:${update.update_id}`)) return;
  const read = readMessage(msg);
  if (!read?.text?.trim()) return;

  const chatId = String(msg.chat.id);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username;

  await inOrder(`${companyId}:${chatId}`, async () => {
    if (read.readable) tg.sendTyping(companyId, chatId).catch(() => {});
    await inbox.receiveMessage({
      companyId,
      channel: 'telegram',
      externalId: chatId,
      text: read.text,
      name,
      phone: read.phone,
      meta: { username: msg.from?.username || null, bot: creds.botUsername || null },
      ai: TG_AI,
      noAnswer: TG_NO_ANSWER,
      allowAI: read.readable,
    });
  });
}

exports.receive = async (req, res) => {
  const { companyId } = req.params;
  if (!mongoose.isValidObjectId(companyId)) return res.sendStatus(404);
  let creds;
  try { creds = await tg.credsFor(companyId); } catch (err) {
    logger.error(`Telegram webhook lookup failed: ${err.message}`);
    return res.sendStatus(500); // Telegram retries later
  }
  if (!creds) return res.sendStatus(404);
  if (!sameSecret(creds.secret, req.headers['x-telegram-bot-api-secret-token'])) {
    logger.warn(`Telegram webhook rejected for company ${companyId}: wrong secret`);
    return res.sendStatus(401);
  }
  // Answer Telegram at once; the AI reply can take a few seconds.
  res.sendStatus(200);
  if (!creds.active) { logger.warn(`Telegram webhook: company ${companyId} is not active — message ignored`); return undefined; }

  handleUpdate(companyId, creds, req.body)
    .catch((err) => logger.error(`Telegram webhook message failed: ${err.message}`));
  return undefined;
};

module.exports._test = { readMessage, handleUpdate };
