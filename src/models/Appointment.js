'use strict';

const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  title: { type: String, required: true },
  description: String,
  customer: { name: String, email: String, phone: String },
  staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  scheduledAt: { type: Date, required: true },
  duration: { type: Number, default: 60 },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show'],
    default: 'pending',
  },
  type: { type: String, default: 'general' },
  location: String,
  isVirtual: { type: Boolean, default: false },
  meetingLink: String,
  // Daily.co video call
  roomUrl: { type: String },
  roomName: { type: String },
  videoCallStartedAt: { type: Date },
  videoCallEndedAt: { type: Date },
  reminderSent: { type: Boolean, default: false },
  notes: String,
  ai: {
    confirmationDraft: String,
    reminderDraft: String,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

appointmentSchema.index({ companyId: 1, scheduledAt: 1 });
appointmentSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model('Appointment', appointmentSchema);