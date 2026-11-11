'use strict';

/**
 * Keeps official-WhatsApp connections healthy:
 *  - flagBroken(): Meta refused a company's token (expired / revoked). Marks
 *    the connection as needing a new token, updates open dashboards, and
 *    tells the owner by email (at most once a day).
 *  - checkAllTokens(): daily. Asks Meta about every connected token, catches
 *    the ones already dead, and warns owners a week before one expires.
 */
const Company = require('../models/Company');
const User = require('../models/User');
const logger = require('./logger');

const DAY = 24 * 60 * 60 * 1000;
const WARN_DAYS = 7;

const appUrl = () => `${(process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '')}/whatsapp`;

function emit(companyId, payload) {
  try { global.io?.to(`company:${companyId}`).emit('whatsapp:token_status', payload); } catch { /* live update only */ }
}

async function emailOwner(company, subject, message) {
  try {
    const owner = await User.findById(company.owner).select('email').lean();
    if (!owner?.email) return;
    const emailService = require('../services/emailService');
    const body = `<p style="color:#475569;line-height:1.7;">${message}</p>
      <p><a href="${appUrl()}" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Open WhatsApp settings</a></p>`;
    await emailService.send({ to: owner.email, subject, html: emailService.baseTemplate(subject, body, { name: company.companyName, logo: company.logo }) });
  } catch (e) { logger.warn(`WhatsApp token email failed (company ${company._id}): ${e.message}`); }
}

const alertedToday = (company) => company.whatsappCloud?.alertedAt && Date.now() - new Date(company.whatsappCloud.alertedAt) < DAY;

/** Meta refused the token. Safe to call often: it only acts once per break. */
async function flagBroken(companyId, reason) {
  const company = await Company.findById(companyId).select('companyName logo owner whatsappCloud.connected whatsappCloud.needsReconnect whatsappCloud.alertedAt');
  if (!company?.whatsappCloud?.connected) return;
  const firstTime = !company.whatsappCloud.needsReconnect;
  const shouldEmail = !alertedToday(company);

  await Company.updateOne({ _id: companyId }, {
    $set: {
      'whatsappCloud.needsReconnect': true,
      'whatsappCloud.lastError': String(reason || 'The access token stopped working.').slice(0, 300),
      'whatsappCloud.lastErrorAt': new Date(),
      ...(shouldEmail ? { 'whatsappCloud.alertedAt': new Date() } : {}),
    },
  });
  if (firstTime) {
    logger.warn(`WhatsApp token for company ${companyId} stopped working — owner asked to reconnect`);
    emit(companyId, { needsReconnect: true, reason });
  }
  if (shouldEmail) {
    await emailOwner(company, 'Your WhatsApp assistant has stopped replying',
      'Meta no longer accepts the access token for your WhatsApp number, so the AI and your team can\'t send replies. '
      + 'Customers\' messages still arrive in your Inbox. Open WhatsApp settings in BizlyAI and paste a new access token to fix it. '
      + 'Tip: a System User token set to "Never expire" avoids this.');
  }
}

/** Daily sweep of every connected number. */
async function checkAllTokens() {
  const cloud = require('../services/whatsappCloud');
  const companies = await Company.find({ 'whatsappCloud.connected': true })
    .select('companyName logo owner whatsappCloud.connected whatsappCloud.accessToken whatsappCloud.tokenExpiresAt whatsappCloud.needsReconnect whatsappCloud.alertedAt');

  for (const company of companies) {
    const token = company.whatsappCloud?.accessToken;
    if (!token) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const info = await cloud.tokenInfo(token);
      if (!info.valid) {
        // eslint-disable-next-line no-await-in-loop
        await flagBroken(company._id, 'The access token is no longer valid.');
        continue;
      }
      const set = { 'whatsappCloud.tokenExpiresAt': info.expiresAt };
      // A valid token again (e.g. Meta hiccup earlier) clears the warning.
      if (company.whatsappCloud.needsReconnect) set['whatsappCloud.needsReconnect'] = false;

      const daysLeft = info.expiresAt ? Math.ceil((info.expiresAt - Date.now()) / DAY) : null;
      const warn = daysLeft !== null && daysLeft <= WARN_DAYS && !alertedToday(company);
      if (warn) set['whatsappCloud.alertedAt'] = new Date();
      // eslint-disable-next-line no-await-in-loop
      await Company.updateOne({ _id: company._id }, { $set: set });
      if (warn) {
        emit(company._id, { expiresAt: info.expiresAt });
        // eslint-disable-next-line no-await-in-loop
        await emailOwner(company, `Your WhatsApp connection expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          `The access token connecting your WhatsApp number to BizlyAI expires on ${info.expiresAt.toDateString()}. `
          + 'After that, replies to customers will stop. Open WhatsApp settings in BizlyAI and paste a new token — '
          + 'a System User token set to "Never expire" means you won\'t have to do this again.');
      }
    } catch (err) {
      if (err.code === 190) {
        // eslint-disable-next-line no-await-in-loop
        await flagBroken(company._id, err.message);
      } else {
        logger.warn(`WhatsApp token check failed (company ${company._id}): ${err.message}`);
      }
    }
  }
}

module.exports = { flagBroken, checkAllTokens };
