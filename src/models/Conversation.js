'use strict';

/**
 * A customer chat on any channel — WhatsApp, the website widget and (next)
 * Facebook Messenger, Instagram, Telegram. Every channel shares this one
 * shape so the team works from a single inbox.
 *
 *   channel + externalId  who the chat is with on that channel
 *                         (WhatsApp: phone digits · widget: browser session id)
 *   status   ai       the AI assistant is answering
 *            human    handed to the team (assignedTo = who claimed it)
 *            resolved closed; the customer writing again reopens it
 */
const mongoose = require('mongoose');

const CHANNELS = ['whatsapp', 'widget', 'facebook', 'instagram', 'telegram'];

const messageSchema = new mongoose.Schema({
  from: { type: String, enum: ['customer', 'ai', 'human', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  agentName: { type: String },
  // Knowledge-base documents an AI answer came from — for the team only.
  sources: { type: [String], default: undefined },
  // A system message the customer also received ("You're now chatting with Ada").
  notice: { type: Boolean, default: undefined },
  // false when the channel could not deliver a reply (e.g. WhatsApp offline).
  delivered: { type: Boolean, default: undefined },
  read: { type: Boolean, default: false },
}, { _id: true });

const conversationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  channel: { type: String, enum: CHANNELS, required: true },
  externalId: { type: String, required: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', default: null },

  displayName: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },

  status: { type: String, enum: ['ai', 'human', 'resolved'], default: 'ai' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  messages: { type: [messageSchema], default: [] },
  lastMessageAt: { type: Date, default: Date.now },
  handoverRequestedAt: { type: Date },
  resolvedAt: { type: Date },

  // Channel extras: widget → originHost, ipAddress, userAgent; WhatsApp → businessPhone.
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Set on records copied from the old WhatsAppConversation / WidgetConversation.
  legacy: {
    model: { type: String },
    id: { type: mongoose.Schema.Types.ObjectId },
  },
}, { timestamps: true });

conversationSchema.index({ companyId: 1, channel: 1, externalId: 1, lastMessageAt: -1 });
conversationSchema.index({ companyId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ companyId: 1, lastMessageAt: -1 });
conversationSchema.index({ companyId: 1, contactId: 1, lastMessageAt: -1 });
conversationSchema.index(
  { 'legacy.id': 1 },
  { unique: true, partialFilterExpression: { 'legacy.id': { $exists: true } } },
);

conversationSchema.statics.CHANNELS = CHANNELS;

module.exports = mongoose.model('Conversation', conversationSchema);
