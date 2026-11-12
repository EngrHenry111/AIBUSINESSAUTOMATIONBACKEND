'use strict';

/**
 * The shared customer inbox. Every channel hands its incoming messages to
 * receiveMessage(); the AI answers from the company's customer-facing
 * knowledge, or the chat is handed to the team. Staff actions (reply, take
 * over, resolve, back to AI) go through the same functions whatever the
 * channel, and each channel only supplies a way to deliver text (channels.js).
 *
 * Socket events (room company:<id>):
 *   inbox:new_message          { conversationId, channel, message }
 *   inbox:handover_needed      { conversationId, channel, displayName, lastMessage }
 *   inbox:conversation_updated { conversationId, status }
 */
const Conversation = require('../../models/Conversation');
const { getEmbedding } = require('../embeddingService');
const { generateSalesReply, HANDOVER_TOKEN } = require('../groqService');
const { hybridSearch, rerankChunks } = require('../../utils/hybridSearch');
const { customerFacingChunks } = require('../../utils/customerKnowledge');
const { cleanAIText } = require('../../utils/cleanAIText');
const { captureLead, contactFromText, excerpt } = require('../../utils/leadCapture');
const logger = require('../../utils/logger');
const { attachContact, linkLead } = require('./contacts');
const channels = require('./channels');
const { catalogContext, customerContext } = require('./salesContext');
const salesFollowUp = require('./salesFollowUp');

// Lead source + timeline label for each channel.
const LEAD_SOURCE = {
  whatsapp: { source: 'whatsapp', activityType: 'whatsapp', label: 'WhatsApp' },
  widget: { source: 'chat_widget', activityType: 'chat', label: 'Website chat' },
  telegram: { source: 'telegram', activityType: 'telegram', label: 'Telegram' },
};

const HANDOVER_KEYWORDS = [
  'human', 'agent', 'real person', 'person', 'representative', 'rep',
  'speak to someone', 'talk to someone', 'talk to a human', 'customer service',
];

// ── Live updates ──────────────────────────────────────────────────────────
function emit(companyId, event, payload) {
  try { global.io?.to(`company:${companyId}`).emit(event, payload); } catch { /* live update only */ }
}
function emitUser(userId, event, payload) {
  try { if (userId) global.io?.to(`user:${userId}`).emit(event, payload); } catch { /* live update only */ }
}

const lastOf = (convo) => convo.messages[convo.messages.length - 1];

function pushMessage(convo, msg) {
  convo.messages.push({ timestamp: new Date(), ...msg });
  convo.lastMessageAt = new Date();
  return lastOf(convo);
}

// ── AI answer: knowledge + live catalog + this customer ───────────────────
/**
 * @returns {Promise<{reply, sources}|null>} null when the AI should not answer
 *   (nothing to answer from, or the model asked for a person)
 */
async function answerFromKnowledge(companyId, text, convo, { floor, topK, keywordHandover }) {
  if (keywordHandover) {
    const lower = text.toLowerCase();
    if (HANDOVER_KEYWORDS.some((k) => lower.includes(k))) return null;
  }

  const [chunks, catalog] = await Promise.all([customerFacingChunks(companyId), catalogContext(companyId, text)]);
  if (!chunks.length && !catalog.text) return null;

  // Knowledge base passages, only when they actually match the question.
  let knowledge = '';
  let sources = [];
  if (chunks.length) {
    let embedding = null;
    try { embedding = await getEmbedding(text); }
    catch { logger.warn('Embedding service down — inbox AI using keyword search only'); }
    const ranked = rerankChunks(hybridSearch(chunks, embedding, text, { topK }), text);
    if (ranked.length && (ranked[0].rerankScore || 0) >= floor) {
      const top = ranked.slice(0, topK);
      knowledge = top.map((r) => r.chunk).join('\n\n---\n\n');
      sources = [...new Set(top.map((r) => r.source).filter(Boolean))];
    }
  }
  // No catalog and nothing relevant in the knowledge base: a person answers.
  if (!knowledge && !catalog.text) return null;

  const customer = await customerContext(convo, { storeUrl: catalog.storeUrl });
  const history = convo.messages
    .slice(0, -1)
    .filter((m) => m.from !== 'system' || m.notice)
    .slice(-8)
    .map((m) => ({ role: m.from === 'customer' ? 'user' : 'assistant', content: m.content }));

  const reply = cleanAIText(await generateSalesReply({
    businessName: catalog.businessName, knowledge, catalog: catalog.text, customer, question: text, history,
  }));
  if (!reply || reply === HANDOVER_TOKEN) return null;
  if (catalog.text) sources.push('Product catalog');
  return { reply, sources };
}

// ── Inbound ───────────────────────────────────────────────────────────────
/**
 * A customer wrote on some channel.
 *
 * @param {Object} p
 * @param {ObjectId} p.companyId
 * @param {string}   p.channel      whatsapp | widget | …
 * @param {string}   p.externalId   who it is on that channel
 * @param {string}   p.text
 * @param {string}   [p.name] [p.email] [p.phone]
 * @param {Object}   [p.meta]       stored on a new conversation
 * @param {Object}   [p.ai]         { floor, topK, keywordHandover }
 * @param {Object}   p.noAnswer     { reply, handover } — what to do when the AI can't answer
 * @param {boolean}  [p.allowAI]    false for things the AI can't read (photos, voice notes)
 * @returns {Promise<{conversation, reply, waitingForHuman}>}
 *   reply is the text sent back (null when a human is handling the chat)
 */
async function receiveMessage({
  companyId, channel, externalId, text, name, email, phone, meta = {},
  ai = { floor: 0.15, topK: 3, keywordHandover: false },
  noAnswer = { reply: 'Please hold, connecting you to our team…', handover: true },
  allowAI = true,
}) {
  const body = String(text || '').trim();
  const typed = contactFromText(body);
  const mail = email || typed.email;
  // A number typed into the chat counts, except on WhatsApp (where the
  // sender's own number is already known and a typed one may be someone else's).
  const tel = phone || (channel !== 'whatsapp' ? typed.phone : undefined);

  let convo = await Conversation.findOne({ companyId, channel, externalId: String(externalId) }).sort({ lastMessageAt: -1 });
  if (!convo) {
    convo = new Conversation({ companyId, channel, externalId: String(externalId), status: 'ai', meta });
  } else if (convo.status === 'resolved') {
    convo.status = 'ai';
    convo.resolvedAt = null;
    convo.assignedTo = null;
    pushMessage(convo, { from: 'system', content: 'Customer wrote again — conversation reopened', read: true });
  }
  if (name && (!convo.displayName || convo.displayName === convo.phone || convo.displayName === convo.externalId)) {
    convo.displayName = String(name).slice(0, 120);
  }
  if (mail && !convo.email) convo.email = String(mail).toLowerCase().slice(0, 160);
  if (phone && channel === 'telegram') {
    // Shared with Telegram's own button: really this customer's number, so it
    // replaces anything they typed and unlocks their order history for the AI.
    convo.phone = String(phone).slice(0, 40);
    convo.meta = { ...(convo.meta || {}), phoneVerified: true };
    convo.markModified('meta');
  } else if (tel && !convo.phone) convo.phone = String(tel).slice(0, 40);
  if (!convo.displayName) convo.displayName = convo.phone || null;

  const inbound = pushMessage(convo, { from: 'customer', content: body, read: false });
  convo.lastCustomerAt = inbound.timestamp;
  await convo.save();

  // Who is this? (contact + lead) — in the background of the reply path,
  // but awaited so the profile is ready when the team opens the chat.
  const contact = await attachContact(convo, { name, email: convo.email, phone: convo.phone }, { requireIdentity: channel === 'widget' });
  const ls = LEAD_SOURCE[channel];
  // The stage check (salesFollowUp) waits for this, so a brand-new lead is
  // there to be moved along.
  let leadReady = null;
  if (ls && (convo.email || convo.phone)) {
    leadReady = captureLead(companyId, {
      source: ls.source,
      name: convo.displayName && convo.displayName !== convo.phone ? convo.displayName : undefined,
      email: convo.email,
      phone: convo.phone,
      activityType: ls.activityType,
      activity: `${ls.label}: "${excerpt(body)}"`,
    }).then((r) => linkLead(contact, r?.lead?._id)).catch(() => {});
  }

  emit(companyId, 'inbox:new_message', { conversationId: convo._id, channel, message: inbound, status: convo.status });

  // A team member is handling this chat — they reply, not the AI.
  if (convo.status === 'human') {
    if (convo.assignedTo) emitUser(convo.assignedTo, 'inbox:new_message', { conversationId: convo._id, channel, message: inbound });
    else emit(companyId, 'inbox:handover_needed', handoverPayload(convo, body));
    salesFollowUp.afterMessage(convo, leadReady);
    return { conversation: convo, reply: null, waitingForHuman: true };
  }

  let answer = null;
  try { if (allowAI) answer = await answerFromKnowledge(companyId, body, convo, ai); }
  catch (err) { logger.error(`Inbox AI reply failed (${channel}): ${err.message}`); }

  if (!answer) {
    if (noAnswer.handover) {
      await handOver(convo, { notice: noAnswer.reply, lastMessage: body });
      salesFollowUp.afterMessage(convo, leadReady);
      return { conversation: convo, reply: noAnswer.reply, waitingForHuman: true };
    }
    await sendFromAI(convo, noAnswer.reply);
    salesFollowUp.afterMessage(convo, leadReady);
    return { conversation: convo, reply: noAnswer.reply, waitingForHuman: false };
  }

  await sendFromAI(convo, answer.reply, answer.sources);
  salesFollowUp.afterMessage(convo, leadReady);
  return { conversation: convo, reply: answer.reply, waitingForHuman: false };
}

async function sendFromAI(convo, text, sources) {
  const result = await channels.deliver(convo, text);
  const msg = pushMessage(convo, {
    from: 'ai', content: text, agentName: 'AI Assistant', read: true,
    sources: sources?.length ? sources : undefined,
    delivered: result.success ? undefined : false,
  });
  await convo.save();
  emit(convo.companyId, 'inbox:new_message', { conversationId: convo._id, channel: convo.channel, message: msg, status: convo.status });
  return msg;
}

function handoverPayload(convo, lastMessage) {
  return {
    conversationId: convo._id,
    channel: convo.channel,
    displayName: convo.displayName || null,
    lastMessage: lastMessage || '',
    handoverRequestedAt: convo.handoverRequestedAt,
  };
}

/** Escalate to the team; `notice` (if any) is also sent to the customer. */
async function handOver(convo, { notice, lastMessage } = {}) {
  convo.status = 'human';
  convo.assignedTo = null;
  convo.handoverRequestedAt = new Date();
  if (notice) {
    const r = await channels.deliver(convo, notice);
    pushMessage(convo, { from: 'system', content: notice, notice: true, read: true, delivered: r.success ? undefined : false });
  } else {
    pushMessage(convo, { from: 'system', content: 'Conversation handed to the team', read: true });
  }
  await convo.save();
  emit(convo.companyId, 'inbox:handover_needed', handoverPayload(convo, lastMessage));
  emit(convo.companyId, 'inbox:conversation_updated', { conversationId: convo._id, status: convo.status });
}

// ── Staff actions ─────────────────────────────────────────────────────────
// Each pushes a system line; `notice` lines are also delivered to the customer.
async function systemNotice(convo, content, { toCustomer }) {
  let delivered;
  if (toCustomer) delivered = (await channels.deliver(convo, content)).success;
  return pushMessage(convo, { from: 'system', content, notice: toCustomer || undefined, read: true, delivered: delivered === false ? false : undefined });
}

async function staffReply(convo, user, text) {
  if (!convo.assignedTo) convo.assignedTo = user._id;
  const result = await channels.deliver(convo, text);
  const msg = pushMessage(convo, {
    from: 'human', content: text, agentName: user.name, read: true, delivered: result.success ? undefined : false,
  });
  await convo.save();
  emit(convo.companyId, 'inbox:new_message', { conversationId: convo._id, channel: convo.channel, message: msg, status: convo.status });
  return { message: msg, delivered: result.success, reason: result.reason };
}

async function takeOver(convo, user) {
  convo.status = 'human';
  convo.assignedTo = user._id;
  if (!convo.handoverRequestedAt) convo.handoverRequestedAt = new Date();
  await systemNotice(convo, `You're now chatting with ${user.name} from our team. How can we help?`, { toCustomer: true });
  await convo.save();
  emit(convo.companyId, 'inbox:conversation_updated', { conversationId: convo._id, status: convo.status, assignedTo: { _id: user._id, name: user.name } });
}

async function resolve(convo, user) {
  convo.status = 'resolved';
  convo.resolvedAt = new Date();
  convo.assignedTo = null;
  await systemNotice(convo, 'This conversation has been marked as resolved. Message us anytime you need more help!', { toCustomer: true });
  await convo.save();
  emit(convo.companyId, 'inbox:conversation_updated', { conversationId: convo._id, status: convo.status });
}

async function backToAI(convo, user) {
  const wasResolved = convo.status === 'resolved';
  convo.status = 'ai';
  convo.assignedTo = null;
  convo.handoverRequestedAt = null;
  convo.resolvedAt = null;
  if (wasResolved) await systemNotice(convo, `${user.name} reopened this conversation for the AI assistant`, { toCustomer: false });
  else await systemNotice(convo, "You're back with our AI assistant. Ask away and we'll help right now.", { toCustomer: true });
  await convo.save();
  emit(convo.companyId, 'inbox:conversation_updated', { conversationId: convo._id, status: convo.status });
}

module.exports = {
  receiveMessage, handOver, staffReply, takeOver, resolve, backToAI, answerFromKnowledge, emit,
};
