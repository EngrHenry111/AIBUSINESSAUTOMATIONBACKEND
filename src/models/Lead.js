'use strict';

const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  company: { type: String, trim: true },
  position: { type: String, trim: true },
  source: { type: String, enum: ['website', 'referral', 'social', 'email', 'cold_call', 'event', 'other'], default: 'other' },
  status: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'converted'],
    default: 'new',
  },
  score: { type: Number, default: 0, min: 0, max: 100 },
  value: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tags: [String],
  // Free-text description (was `notes` — renamed so `notes` can be a thread)
  description: { type: String, maxlength: 4000 },
  notes: [{
    content: { type: String, required: true, maxlength: 4000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  }],
  lastContactedAt: { type: Date },
  nextFollowUpAt: { type: Date },
  ai: {
    summary: String,
    recommendedAction: String,
    followUpDraft: String,
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative'] },
    priority: { type: String, enum: ['high', 'medium', 'low'] },
    analyzedAt: Date,
  },
  activities: [{
    type: { type: String, enum: ['email', 'call', 'meeting', 'note', 'status_change'] },
    description: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedAt: { type: Date, default: Date.now },
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

leadSchema.index({ companyId: 1, status: 1 });
leadSchema.index({ companyId: 1, assignedTo: 1 });
leadSchema.index({ companyId: 1, nextFollowUpAt: 1 });

module.exports = mongoose.model('Lead', leadSchema);