'use strict';

const mongoose = require('mongoose');

const waMessageSchema = new mongoose.Schema({
  from: { type: String, enum: ['customer', 'ai', 'human', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  agentName: { type: String },
  read: { type: Boolean, default: false },
}, { _id: true });

const whatsappConversationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  businessPhone: { type: String },          // the company's connected WhatsApp number
  customerPhone: { type: String, required: true },
  customerName: { type: String },
  // ai            → the bot is handling it (default)
  // active        → alias kept for compatibility with older data
  // human_takeover→ escalated to / handled by a team member
  // resolved      → closed
  status: { type: String, enum: ['ai', 'active', 'human_takeover', 'resolved'], default: 'ai' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  messages: { type: [waMessageSchema], default: [] },
  lastMessageAt: { type: Date, default: Date.now },
  handoverRequestedAt: { type: Date },
  resolvedAt: { type: Date },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

whatsappConversationSchema.index({ companyId: 1, status: 1, lastMessageAt: -1 });
whatsappConversationSchema.index({ companyId: 1, customerPhone: 1, status: 1 });
whatsappConversationSchema.index({ companyId: 1, assignedTo: 1 });

module.exports = mongoose.model('WhatsAppConversation', whatsappConversationSchema);
