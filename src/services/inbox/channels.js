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
  // whatsapp-web.js session (required lazily: whatsappService requires the inbox).
  whatsapp: (convo, text) => require('../whatsappService').sendToCustomer(convo.companyId, convo.externalId, text),

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
