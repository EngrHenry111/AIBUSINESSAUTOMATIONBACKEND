'use strict';

const mongoose = require('mongoose');

// One chat with the business assistant (services/assistant). `messages` is
// the model's own transcript — user, assistant (with tool_calls) and tool
// results — replayed on every turn. Anything that changes data or contacts
// someone is never done inside a turn: it becomes an `actions` entry that
// waits for the person to approve it.
const actionSchema = new mongoose.Schema({
  tool: { type: String, required: true },
  args: { type: mongoose.Schema.Types.Mixed, default: {} },
  summary: { type: String, required: true },
  details: { type: [String], default: [] },
  status: { type: String, enum: ['pending', 'running', 'done', 'failed', 'rejected', 'expired'], default: 'pending' },
  result: { type: String },
  decidedAt: { type: Date },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const conversationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New chat', maxlength: 120 },
  messages: { type: [mongoose.Schema.Types.Mixed], default: [] },
  actions: { type: [actionSchema], default: [] },
}, { timestamps: true, minimize: false });

conversationSchema.index({ companyId: 1, userId: 1, updatedAt: -1 });

module.exports = mongoose.model('AssistantConversation', conversationSchema);
