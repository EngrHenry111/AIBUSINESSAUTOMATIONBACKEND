'use strict';

/**
 * How text reaches the customer on each channel. Adding Messenger or
 * Instagram means adding one entry here plus a webhook that
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

  // Telegram doesn't tell a bot the customer's phone number, so the first
  // reply offers a one-tap "Share my phone number" button (that's what turns
  // the chat into a lead); once shared, the next reply removes the button.
  telegram: async (convo, text) => {
    const tg = require('../telegram');
    const meta = convo.meta || {};
    let replyMarkup;
    let mark;
    if (!convo.phone && !meta.askedPhone) {
      replyMarkup = SHARE_PHONE;
      mark = 'meta.askedPhone';
    } else if (convo.phone && meta.askedPhone && !meta.phoneButtonClosed) {
      replyMarkup = { remove_keyboard: true };
      mark = 'meta.phoneButtonClosed';
    }
    const result = await tg.sendText(convo.companyId, convo.externalId, text, { replyMarkup });
    if (result.success && mark) {
      convo.meta = { ...meta, [mark.slice(5)]: true };
      await Conversation().updateOne({ _id: convo._id }, { $set: { [mark]: true } }).catch(() => {});
    }
    return result;
  },
};

const SHARE_PHONE = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
  input_field_placeholder: 'Type a message…',
};
const Conversation = () => require('../../models/Conversation');

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
