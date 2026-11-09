'use strict';

/**
 * Copies chats saved before the shared inbox (WhatsAppConversation,
 * WidgetConversation) into Conversation, and links each to a Contact.
 *
 * Runs on every startup and is idempotent: each copy carries legacy.id, so a
 * record already copied is skipped. The old collections are left untouched
 * (nothing writes to them any more) so this can be checked or re-run safely.
 */
const Conversation = require('../models/Conversation');
const WhatsAppConversation = require('../models/WhatsAppConversation');
const WidgetConversation = require('../models/WidgetConversation');
const { attachContact } = require('../services/inbox/contacts');
const logger = require('./logger');

const WA_STATUS = { ai: 'ai', active: 'ai', human_takeover: 'human', resolved: 'resolved' };

function fromWhatsApp(c) {
  return {
    companyId: c.companyId,
    channel: 'whatsapp',
    externalId: String(c.customerPhone),
    displayName: c.customerName && c.customerName !== c.customerPhone ? c.customerName : c.customerPhone,
    phone: c.customerPhone,
    status: WA_STATUS[c.status] || 'ai',
    assignedTo: c.assignedTo || null,
    messages: (c.messages || []).map((m) => ({
      _id: m._id, from: m.from, content: m.content, timestamp: m.timestamp, agentName: m.agentName, read: m.read,
    })),
    lastMessageAt: c.lastMessageAt,
    handoverRequestedAt: c.handoverRequestedAt,
    resolvedAt: c.resolvedAt,
    meta: { businessPhone: c.businessPhone || '' },
    legacy: { model: 'WhatsAppConversation', id: c._id },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function fromWidget(c) {
  return {
    companyId: c.companyId,
    channel: 'widget',
    externalId: String(c.sessionId),
    displayName: c.visitorName || undefined,
    email: c.visitorEmail || undefined,
    status: c.isResolved ? 'resolved' : c.handedToHuman ? 'human' : 'ai',
    assignedTo: c.assignedTo || null,
    messages: (c.messages || []).map((m) => ({
      _id: m._id,
      from: m.role === 'user' ? 'customer' : m.sentBy === 'human' ? 'human' : 'ai',
      content: m.content,
      timestamp: m.timestamp,
      agentName: m.agentName,
      sources: m.sources?.length ? m.sources : undefined,
      // Only the visitor's messages count as unread for the team.
      read: m.role === 'user' ? m.read : true,
    })),
    lastMessageAt: c.lastMessageAt,
    handoverRequestedAt: c.handoverRequestedAt,
    resolvedAt: c.resolvedAt,
    meta: { originHost: c.originHost, ipAddress: c.ipAddress, userAgent: c.userAgent },
    legacy: { model: 'WidgetConversation', id: c._id },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function copyAll(Model, map, label) {
  const done = new Set((await Conversation.find({ 'legacy.model': label }).distinct('legacy.id')).map(String));
  let copied = 0;
  for await (const old of Model.find().lean().cursor()) {
    if (done.has(String(old._id))) continue;
    const doc = map(old);
    if (!doc.messages.length) continue;
    try {
      const [convo] = await Conversation.insertMany([doc], { timestamps: false });
      await attachContact(convo, { name: doc.displayName, email: doc.email, phone: doc.phone }, { requireIdentity: doc.channel === 'widget' });
      copied += 1;
    } catch (err) {
      if (err.code !== 11000) logger.warn(`Inbox migration: ${label} ${old._id} skipped: ${err.message}`);
    }
  }
  return copied;
}

async function migrateConversations() {
  try {
    await Conversation.init(); // unique legacy.id index must exist before copying
    const wa = await copyAll(WhatsAppConversation, fromWhatsApp, 'WhatsAppConversation');
    const widget = await copyAll(WidgetConversation, fromWidget, 'WidgetConversation');
    if (wa || widget) logger.info(`✅ Inbox migration: ${wa} WhatsApp + ${widget} website chats copied into the shared inbox`);
    return { wa, widget };
  } catch (err) {
    logger.error(`Inbox migration failed: ${err.message}`);
    return { wa: 0, widget: 0, error: err.message };
  }
}

module.exports = { migrateConversations, fromWhatsApp, fromWidget };
