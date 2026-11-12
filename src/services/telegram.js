'use strict';

/**
 * Telegram bots (Bot API). Each business makes its own bot with @BotFather
 * and pastes the token into BizlyAI; we point the bot's webhook at
 *   POST /api/v1/webhooks/telegram/<companyId>
 * with a random secret that Telegram sends back in the
 * X-Telegram-Bot-Api-Secret-Token header, so nobody else can post chats in.
 *
 * Free: no templates, no 24-hour window — a bot can message anyone who has
 * started a chat with it, until they block it.
 */
const crypto = require('crypto');
const Company = require('../models/Company');
const logger = require('../utils/logger');

const API = 'https://api.telegram.org';
const WEBHOOK_PATH = '/api/v1/webhooks/telegram';
const DAY = 24 * 60 * 60 * 1000;
const MAX_TEXT = 4000; // Telegram allows 4096 characters per message

// A @BotFather token: "<bot id>:<35 characters>".
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const cleanToken = (t) => String(t || '').trim().replace(/^["']+|["']+$/g, '').trim();

class TelegramError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const FRIENDLY = {
  401: 'Telegram did not accept this bot token. Copy it again from @BotFather (/mybots → your bot → API Token).',
  404: 'Telegram did not accept this bot token. Copy it again from @BotFather (/mybots → your bot → API Token).',
};

async function call(token, method, params = {}) {
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new TelegramError(`Could not reach Telegram (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`, 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!data.ok) {
    const code = data.error_code || res.status;
    let msg = FRIENDLY[code] || data.description || `Telegram error ${code}`;
    if (/HTTPS URL must be provided/i.test(data.description || '')) msg = 'Telegram only sends chats to a secure (https) server address. Set API_URL to the live https address of the backend.';
    if (code === 403 && /blocked by the user/i.test(data.description || '')) msg = 'This customer has blocked the bot, so Telegram will not deliver messages to them.';
    if (code === 403 && /user is deactivated/i.test(data.description || '')) msg = 'This customer deleted their Telegram account.';
    if (code === 429) msg = 'Telegram is limiting how fast the bot can send. Try again in a few seconds.';
    throw new TelegramError(msg, code);
  }
  return data.result;
}

// ── Which bot belongs to which company ────────────────────────────────────
const credCache = new Map(); // companyId -> { at, creds }
const CACHE_MS = 60 * 1000;

async function credsFor(companyId) {
  const key = String(companyId);
  const hit = credCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.creds;
  const company = await Company.findById(companyId)
    .select('status telegram.connected telegram.botUsername +telegram.botToken +telegram.webhookSecret').lean();
  const tg = company?.telegram;
  const creds = tg?.connected && tg.botToken
    ? { token: tg.botToken, secret: tg.webhookSecret, botUsername: tg.botUsername, active: company.status === 'active' }
    : null;
  credCache.set(key, { at: Date.now(), creds });
  return creds;
}
const forget = (companyId) => credCache.delete(String(companyId));

const webhookUrl = (base, companyId) => `${String(base || '').replace(/\/+$/, '')}${WEBHOOK_PATH}/${companyId}`;

// ── Connect / disconnect ──────────────────────────────────────────────────
/**
 * Checks the token with Telegram and points the bot at us.
 * @returns {Promise<{botId, botUsername, botName, secret}>}
 */
async function connectBot({ companyId, token, baseUrl }) {
  const t = cleanToken(token);
  if (!TOKEN_RE.test(t)) throw new TelegramError('That does not look like a bot token. It looks like 1234567890:AAH… — copy the whole line from @BotFather.', 400);
  const me = await call(t, 'getMe');
  if (!me?.is_bot) throw new TelegramError('This token is not for a bot.', 400);

  const secret = crypto.randomBytes(24).toString('hex');
  await call(t, 'setWebhook', {
    url: webhookUrl(baseUrl, companyId),
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
    max_connections: 20,
  });
  return { botId: String(me.id), botUsername: me.username, botName: me.first_name, secret, token: t };
}

/** Stop the bot sending us chats. Best effort: the token may already be dead. */
async function disconnectBot(token) {
  if (!token) return;
  try { await call(token, 'deleteWebhook', { drop_pending_updates: false }); }
  catch (err) { logger.warn(`Telegram deleteWebhook failed: ${err.message}`); }
}

/** Webhook health for the settings page: is Telegram reaching us? */
async function webhookInfo(companyId) {
  const creds = await credsFor(companyId);
  if (!creds) return null;
  const info = await call(creds.token, 'getWebhookInfo');
  return {
    url: info.url || '',
    pending: info.pending_update_count || 0,
    lastError: info.last_error_message || null,
    lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000) : null,
  };
}

// ── Token stopped working ─────────────────────────────────────────────────
const appUrl = () => `${(process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '')}/telegram`;

async function flagBroken(companyId, reason) {
  forget(companyId);
  const company = await Company.findById(companyId).select('companyName logo owner telegram.connected telegram.needsReconnect telegram.alertedAt telegram.botUsername');
  if (!company?.telegram?.connected) return;
  const firstTime = !company.telegram.needsReconnect;
  const alerted = company.telegram.alertedAt && Date.now() - new Date(company.telegram.alertedAt) < DAY;
  await Company.updateOne({ _id: companyId }, {
    $set: {
      'telegram.needsReconnect': true,
      'telegram.lastError': String(reason || '').slice(0, 300),
      'telegram.lastErrorAt': new Date(),
      ...(alerted ? {} : { 'telegram.alertedAt': new Date() }),
    },
  });
  if (firstTime) logger.warn(`Telegram bot for company ${companyId} stopped working — owner asked to reconnect`);
  try { global.io?.to(`company:${companyId}`).emit('telegram:status', { needsReconnect: true }); } catch { /* live only */ }
  if (alerted) return;
  try {
    const User = require('../models/User');
    const owner = await User.findById(company.owner).select('email').lean();
    if (!owner?.email) return;
    const emailService = require('./emailService');
    const subject = 'Your Telegram bot has stopped replying';
    const bot = company.telegram.botUsername ? `@${company.telegram.botUsername}` : 'your Telegram bot';
    const body = `<p style="color:#475569;line-height:1.7;">Telegram no longer accepts the token for ${bot}, so customers writing to it are not getting replies. This happens when the token is revoked in @BotFather or the bot is deleted.</p>
      <p style="color:#475569;line-height:1.7;">Open @BotFather, choose /mybots → your bot → API Token, copy it and connect again in BizlyAI.</p>
      <p><a href="${appUrl()}" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Open Telegram settings</a></p>`;
    await emailService.send({ to: owner.email, subject, html: emailService.baseTemplate(subject, body, { name: company.companyName, logo: company.logo }) });
  } catch (e) { logger.warn(`Telegram alert email failed (company ${companyId}): ${e.message}`); }
}

// ── Sending ───────────────────────────────────────────────────────────────
function split(text) {
  const parts = [];
  let rest = String(text || '');
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf('\n', MAX_TEXT);
    if (cut < MAX_TEXT / 2) cut = rest.lastIndexOf(' ', MAX_TEXT);
    if (cut < MAX_TEXT / 2) cut = MAX_TEXT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * @param {Object} [opts] { replyMarkup } — keyboard sent with the last part
 * @returns {Promise<{success, reason?}>} never throws
 */
async function sendText(companyId, chatId, text, { replyMarkup } = {}) {
  const creds = await credsFor(companyId);
  if (!creds) return { success: false, reason: 'Telegram is not connected.' };
  const parts = split(text);
  try {
    for (let i = 0; i < parts.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await call(creds.token, 'sendMessage', {
        chat_id: chatId,
        text: parts[i],
        link_preview_options: { is_disabled: false },
        ...(replyMarkup && i === parts.length - 1 ? { reply_markup: replyMarkup } : {}),
      });
    }
    return { success: true };
  } catch (err) {
    if (err.code === 401 || err.code === 404) await flagBroken(companyId, err.message).catch(() => {});
    logger.warn(`Telegram send failed (company ${companyId}): ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/** "typing…" while the AI thinks. Best effort. */
async function sendTyping(companyId, chatId) {
  const creds = await credsFor(companyId);
  if (!creds) return;
  try { await call(creds.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }); } catch { /* cosmetic */ }
}

module.exports = {
  call, credsFor, forget, connectBot, disconnectBot, webhookInfo, webhookUrl, flagBroken,
  sendText, sendTyping, cleanToken, TelegramError, WEBHOOK_PATH,
};
