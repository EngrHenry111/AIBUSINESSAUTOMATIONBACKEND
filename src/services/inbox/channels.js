'use strict';

/**
 * How text reaches the customer on each channel. Adding Messenger,
 * Instagram or Telegram means adding one entry here plus a webhook that
 * calls inbox.receiveMessage().
 *
 * deliver() never throws; it resolves { success, reason }.
 */
const logger = require('../../utils/logger');

const adapters = {
  // Official Cloud API when the company has connected it; otherwise the
  // older QR-code session (required lazily: both services require the inbox).
  whatsapp: async (convo, text) => {
    const cloud = require('../whatsappCloud');
    if (await cloud.isConnected(convo.companyId)) return cloud.sendText(convo.companyId, convo.externalId, text);
    return require('../whatsappService').sendToCustomer(convo.companyId, convo.externalId, text);
  },

  // The website widget fetches new messages itself (it polls the chat history),
  // so saving the message on the conversation is all delivery takes.
  widget: async () => ({ success: true }),
};

async function deliver(convo, text) {
  const send = adapters[convo.channel];
  if (!send) return { success: false, reason: `Sending on ${convo.channel} is not set up yet.` };
  try {
    return (await send(convo, text)) || { success: true };
  } catch (err) {
    logger.error(`Inbox delivery failed (${convo.channel}): ${err.message}`);
    return { success: false, reason: err.message };
  }
}

module.exports = { deliver };
