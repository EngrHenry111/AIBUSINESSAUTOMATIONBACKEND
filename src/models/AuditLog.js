'use strict';

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  resource: { type: String },
  resourceId: { type: String },
  description: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  status: { type: String, enum: ['success', 'failure'], default: 'success' },
  timestamp: { type: Date, default: Date.now, immutable: true },
}, { timestamps: false });

auditLogSchema.index({ companyId: 1, timestamp: -1 });
auditLogSchema.index({ companyId: 1, userId: 1 });
auditLogSchema.index({ companyId: 1, action: 1 });
auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);