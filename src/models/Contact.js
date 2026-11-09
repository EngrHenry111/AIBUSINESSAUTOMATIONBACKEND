'use strict';

/**
 * One real person a business talks to, across every channel.
 *
 * A customer who writes on WhatsApp today and through the website chat next
 * week is the same Contact: each channel identity (phone number, widget
 * session, Instagram id …) is kept in `handles`, and a contact is found again
 * by any handle, by phone (last 10 digits) or by email. The contact also
 * points at the matching Lead and Customer, so the inbox can show the whole
 * relationship next to any conversation.
 */
const mongoose = require('mongoose');

const handleSchema = new mongoose.Schema({
  channel: { type: String, required: true },
  externalId: { type: String, required: true },
}, { _id: false });

const contactSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, trim: true, maxlength: 200 },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  phoneKey: { type: String }, // last 10 digits, so 080… and +23480… match
  handles: { type: [handleSchema], default: [] },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  lastChannel: { type: String },
  notes: { type: String, maxlength: 5000 },
}, { timestamps: true });

const phoneKeyOf = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : undefined;
};
contactSchema.statics.phoneKeyOf = phoneKeyOf;
contactSchema.pre('save', function setPhoneKey(next) {
  if (this.isModified('phone')) this.phoneKey = phoneKeyOf(this.phone);
  next();
});

contactSchema.index({ companyId: 1, 'handles.channel': 1, 'handles.externalId': 1 });
contactSchema.index({ companyId: 1, phoneKey: 1 });
contactSchema.index({ companyId: 1, email: 1 });
contactSchema.index({ companyId: 1, lastSeenAt: -1 });

module.exports = mongoose.model('Contact', contactSchema);
