'use strict';

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  sources: [{
    document: String,
    score: Number,
    preview: String,
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  }],
  confidence: { type: Number, min: 0, max: 100 },
  model: { type: String },
  tokensUsed: { type: Number },
  feedback: { type: String, enum: ['up', 'down', null], default: null },
}, { timestamps: true });

const chatSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New conversation', maxlength: 200 },
  knowledgeBaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase' },
  messages: [messageSchema],
  agentId: { type: String },
  totalTokens: { type: Number, default: 0 },
  isArchived: { type: Boolean, default: false },
  lastMessageAt: { type: Date },
}, { timestamps: true });

chatSchema.index({ companyId: 1, userId: 1, isArchived: 1 });
chatSchema.index({ companyId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);