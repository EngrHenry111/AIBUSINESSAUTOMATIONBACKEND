'use strict';

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true, maxlength: 5000 },
  type: { type: String, enum: ['text', 'file', 'system'], default: 'text' },
  fileUrl: { type: String },
  fileName: { type: String },
  readAt: { type: Date, default: null },
  isRead: { type: Boolean, default: false },
  edited: { type: Boolean, default: false },
  editedAt: { type: Date },
}, { timestamps: true });

messageSchema.index({ companyId: 1, senderId: 1, recipientId: 1, createdAt: -1 });
messageSchema.index({ companyId: 1, recipientId: 1, isRead: 1 });

module.exports = mongoose.model('Message', messageSchema);
