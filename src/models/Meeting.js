'use strict';

const mongoose = require('mongoose');

const MEETING_TYPES = [
  'board', 'management', 'team', 'client', 'agm', 'egm',
  'committee', 'strategy', 'review', 'townhall',
];

const RECURRING_INTERVALS = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annually'];

const meetingSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String },
  meetingType: { type: String, enum: MEETING_TYPES, default: 'team' },
  referenceNumber: { type: String, trim: true }, // MTG/2026/001
  location: { type: String, trim: true },
  chairman: { type: String, trim: true },
  secretary: { type: String, trim: true },

  scheduledAt: { type: Date },
  duration: { type: Number },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  externalParticipants: [{ name: String, email: String }],
  transcript: { type: String },
  transcriptFile: { type: String },
  status: { type: String, enum: ['scheduled', 'in_progress', 'completed', 'cancelled'], default: 'scheduled' },

  // ── Agenda builder ──────────────────────────────────────────────────
  agenda: [{
    number: Number,
    title: { type: String, required: true },
    presenter: String,
    timeAllocated: Number, // minutes
    notes: String,
    completed: { type: Boolean, default: false },
  }],

  // ── Attendance tracking ─────────────────────────────────────────────
  attendance: [{
    name: String,
    email: String,
    role: String,
    status: { type: String, enum: ['present', 'absent', 'excused'], default: 'absent' },
  }],
  quorumRequired: { type: Number, default: 50 }, // percentage of invited attendees
  quorumReached: { type: Boolean, default: false },

  // ── Resolutions / motions ───────────────────────────────────────────
  resolutions: [{
    number: String, // e.g. "001/2026"
    description: { type: String, required: true },
    proposedBy: String,
    secondedBy: String,
    votesFor: { type: Number, default: 0 },
    votesAgainst: { type: Number, default: 0 },
    votesAbstain: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'carried', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now },
  }],

  // ── Action items tracker ────────────────────────────────────────────
  actionItems: [{
    task: { type: String, required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: String, // display fallback / external assignee
    dueDate: Date,
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    completedAt: Date,
    createdAt: { type: Date, default: Date.now },
  }],

  // ── Minutes & documents ──────────────────────────────────────────────
  minutes: { type: String },
  minutesStatus: { type: String, enum: ['draft', 'final'], default: 'draft' },
  attachments: [{
    name: String,
    url: String,
    category: { type: String, enum: ['agenda', 'presentation', 'document'], default: 'document' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  }],

  // ── Recurring meetings ───────────────────────────────────────────────
  isRecurring: { type: Boolean, default: false },
  recurringInterval: { type: String, enum: RECURRING_INTERVALS },
  nextOccurrenceCreated: { type: Boolean, default: false },

  // ── Formal-meeting continuity ────────────────────────────────────────
  previousMeetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting' },
  previousMinutesConfirmed: { type: Boolean, default: false },
  previousMinutesConfirmedBy: String,
  previousMinutesConfirmedAt: Date,

  // ── Reminder dedupe flags (backend cron) ────────────────────────────
  reminders: {
    sent24h: { type: Boolean, default: false },
    sent1h: { type: Boolean, default: false },
  },

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
meetingSchema.index({ companyId: 1, referenceNumber: 1 });
meetingSchema.index({ status: 1, scheduledAt: 1, 'reminders.sent24h': 1, 'reminders.sent1h': 1 });

meetingSchema.statics.MEETING_TYPES = MEETING_TYPES;
meetingSchema.statics.RECURRING_INTERVALS = RECURRING_INTERVALS;

module.exports = mongoose.model('Meeting', meetingSchema);
