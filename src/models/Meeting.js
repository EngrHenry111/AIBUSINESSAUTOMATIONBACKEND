'use strict';

const mongoose = require('mongoose');

const meetingSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String },
  scheduledAt: { type: Date },
  duration: { type: Number },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  externalParticipants: [{ name: String, email: String }],
  transcript: { type: String },
  transcriptFile: { type: String },
  status: { type: String, enum: ['scheduled', 'in_progress', 'completed', 'cancelled'], default: 'scheduled' },
  ai: {
    summary: { type: String },
    keyDecisions: [String],
    actionItems: [{
      task: String,
      assignedTo: String,
      dueDate: Date,
      priority: { type: String, enum: ['high', 'medium', 'low'] },
      completed: { type: Boolean, default: false },
    }],
    risks: [String],
    followUps: [String],
    sentiment: String,
    processedAt: Date,
  },
  recordingUrl: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

meetingSchema.index({ companyId: 1, scheduledAt: -1 });
meetingSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model('Meeting', meetingSchema);