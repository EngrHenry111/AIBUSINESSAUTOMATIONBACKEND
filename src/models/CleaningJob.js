'use strict';

const mongoose = require('mongoose');

// A cleaning visit: where, what, who is going, and how it went.

const STATUSES = ['scheduled', 'on_the_way', 'in_progress', 'completed', 'cancelled'];
const FREQUENCIES = ['none', 'weekly', 'biweekly', 'monthly'];

const cleaningJobSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  jobNumber: { type: String, required: true },
  customer: {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
  },
  address: { type: String, required: true, trim: true, maxlength: 400 },
  area: { type: String, trim: true, maxlength: 100 },
  landmark: { type: String, trim: true, maxlength: 200 },
  accessNotes: { type: String, trim: true, maxlength: 500 }, // gate code, who opens, pets…
  property: {
    type: { type: String, enum: ['flat', 'duplex', 'bungalow', 'terrace', 'office', 'shop', 'other'], default: 'flat' },
    bedrooms: { type: Number, min: 0, max: 50, default: 0 },
    bathrooms: { type: Number, min: 0, max: 50, default: 0 },
  },
  service: { type: String, required: true },
  extras: [{ name: String, price: Number, quantity: { type: Number, default: 1 } }],
  scheduledAt: { type: Date, required: true },
  hours: { type: Number, default: 3 },
  team: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: String }],
  checklist: [{ task: String, done: { type: Boolean, default: false }, doneAt: Date, doneBy: String }],
  photos: [{ url: String, kind: { type: String, enum: ['before', 'after'] }, at: { type: Date, default: Date.now }, byName: String }],
  price: {
    base: { type: Number, default: 0 },
    rooms: { type: Number, default: 0 },
    extras: { type: Number, default: 0 },
    transport: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  amountPaid: { type: Number, default: 0 },
  payments: [{
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ['cash', 'transfer', 'pos_terminal'], required: true },
    note: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String,
  }],
  currency: { type: String, default: 'NGN' },
  status: { type: String, enum: STATUSES, default: 'scheduled' },
  startedAt: Date,
  completedAt: Date,
  cancelReason: String,
  rating: { type: Number, min: 1, max: 5 },
  feedback: { type: String, maxlength: 500 },
  recurrence: { type: String, enum: FREQUENCIES, default: 'none' },
  seriesId: { type: mongoose.Schema.Types.ObjectId }, // every visit in a repeating booking
  nextJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'CleaningJob' },
  timeline: [{ status: String, note: String, at: { type: Date, default: Date.now }, byName: String }],
  notes: { type: String, maxlength: 1000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

cleaningJobSchema.virtual('balance').get(function balance() {
  return Math.max(0, Math.round(((this.price?.total || 0) - (this.amountPaid || 0)) * 100) / 100);
});

cleaningJobSchema.index({ companyId: 1, jobNumber: 1 }, { unique: true });
cleaningJobSchema.index({ companyId: 1, scheduledAt: 1 });
cleaningJobSchema.index({ companyId: 1, 'team.userId': 1, scheduledAt: 1 });
cleaningJobSchema.index({ companyId: 1, 'payments.at': 1 });

cleaningJobSchema.statics.STATUSES = STATUSES;
cleaningJobSchema.statics.FREQUENCIES = FREQUENCIES;
module.exports = mongoose.model('CleaningJob', cleaningJobSchema);
