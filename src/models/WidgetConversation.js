'use strict';

const mongoose = require('mongoose');

const widgetMessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  sources: { type: [String], default: [] },
  // Extends the base "user/assistant" shape so the inbox UI can tell an
  // AI-generated reply from one a team member typed after taking over —
  // both are still role:'assistant' from the widget script's point of view.
  sentBy: { type: String, enum: ['ai', 'human'], default: 'ai' },
  agentName: { type: String },
  read: { type: Boolean, default: false },
}, { _id: true });

const widgetConversationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  sessionId: { type: String, required: true }, // random id the visitor's browser generates and keeps in localStorage
  visitorName: { type: String, trim: true },
  visitorEmail: { type: String, trim: true, lowercase: true },
  messages: { type: [widgetMessageSchema], default: [] },
  isResolved: { type: Boolean, default: false },
  handedToHuman: { type: Boolean, default: false },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  handoverRequestedAt: { type: Date },
  resolvedAt: { type: Date },
  lastMessageAt: { type: Date, default: Date.now },
  ipAddress: { type: String },
  userAgent: { type: String },
  originHost: { type: String }, // hostname the widget was loaded from, e.g. "clientsite.com"
}, { timestamps: true });

widgetConversationSchema.index({ companyId: 1, sessionId: 1 });
widgetConversationSchema.index({ companyId: 1, isResolved: 1, handedToHuman: 1, lastMessageAt: -1 });
widgetConversationSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('WidgetConversation', widgetConversationSchema);
