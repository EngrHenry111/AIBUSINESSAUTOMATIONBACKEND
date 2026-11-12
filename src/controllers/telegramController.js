'use strict';

/**
 * Connecting a business's Telegram bot (made with @BotFather). Chats arrive
 * in the shared Inbox; see controllers/telegramWebhookController.js.
 */
const Company = require('../models/Company');
const tg = require('../services/telegram');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

const baseUrl = (req) => (process.env.API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

function view(company) {
  const t = company?.telegram || {};
  return {
    connected: Boolean(t.connected),
    botUsername: t.botUsername || null,
    botName: t.botName || null,
    link: t.connected && t.botUsername ? `https://t.me/${t.botUsername}` : null,
    connectedAt: t.connectedAt || null,
    needsReconnect: Boolean(t.connected && t.needsReconnect),
    lastError: t.connected && t.needsReconnect ? t.lastError || null : null,
  };
}

exports.getStatus = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('telegram').lean();
    const data = view(company);
    // Is Telegram reaching us? Only worth asking when connected.
    if (data.connected && !data.needsReconnect) {
      try {
        const info = await tg.webhookInfo(req.companyId);
        const recent = info?.lastErrorAt && Date.now() - new Date(info.lastErrorAt) < 6 * 60 * 60 * 1000;
        data.delivery = info ? { pending: info.pending, problem: recent ? info.lastError : null, pointedHere: info.url === tg.webhookUrl(baseUrl(req), req.companyId) } : null;
      } catch (err) {
        if (err.code === 401 || err.code === 404) {
          await tg.flagBroken(req.companyId, err.message);
          data.needsReconnect = true;
          data.lastError = err.message;
        }
      }
    }
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

exports.connect = async (req, res, next) => {
  try {
    const token = tg.cleanToken(req.body.botToken);
    if (!token) return next(new AppError('Paste the bot token from @BotFather.', 400));

    // Same bot already connected to another business?
    const botId = token.split(':')[0];
    const taken = await Company.findOne({ _id: { $ne: req.companyId }, 'telegram.botId': botId }).select('_id').lean();
    if (taken) return next(new AppError('This Telegram bot is already connected to another business on BizlyAI. Create a new bot with @BotFather for this business.', 409));

    // Switching bots: the old one stops sending chats here.
    const before = await Company.findById(req.companyId).select('telegram.botId +telegram.botToken').lean();

    let bot;
    try {
      bot = await tg.connectBot({ companyId: req.companyId, token, baseUrl: baseUrl(req) });
    } catch (err) {
      return next(new AppError(err.message, err.code >= 400 && err.code < 500 ? 400 : 502));
    }
    if (before?.telegram?.botToken && before.telegram.botId !== bot.botId) await tg.disconnectBot(before.telegram.botToken);

    const company = await Company.findByIdAndUpdate(req.companyId, {
      $set: {
        'telegram.connected': true,
        'telegram.botToken': bot.token,
        'telegram.webhookSecret': bot.secret,
        'telegram.botId': bot.botId,
        'telegram.botUsername': bot.botUsername,
        'telegram.botName': bot.botName,
        'telegram.connectedAt': new Date(),
        'telegram.needsReconnect': false,
      },
      $unset: { 'telegram.lastError': 1, 'telegram.lastErrorAt': 1, 'telegram.alertedAt': 1 },
    }, { new: true }).select('telegram');
    tg.forget(req.companyId);
    try { global.io?.to(`company:${req.companyId}`).emit('telegram:status', { needsReconnect: false }); } catch { /* live only */ }

    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'telegram.connect', ip: req.ip, metadata: { bot: bot.botUsername } });
    res.status(200).json({ success: true, data: view(company), message: `Connected @${bot.botUsername}.` });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('This Telegram bot is already connected to another business on BizlyAI.', 409));
    next(err);
  }
};

exports.disconnect = async (req, res, next) => {
  try {
    const before = await Company.findById(req.companyId).select('+telegram.botToken').lean();
    await tg.disconnectBot(before?.telegram?.botToken);
    const company = await Company.findByIdAndUpdate(req.companyId, {
      $set: { 'telegram.connected': false, 'telegram.needsReconnect': false },
      $unset: { 'telegram.botToken': 1, 'telegram.webhookSecret': 1, 'telegram.botId': 1, 'telegram.lastError': 1 },
    }, { new: true }).select('telegram');
    tg.forget(req.companyId);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'telegram.disconnect', ip: req.ip });
    res.status(200).json({ success: true, data: view(company), message: 'Telegram disconnected.' });
  } catch (err) { next(err); }
};
