'use strict';

const mongoose = require('mongoose');

// One-time magic-link token that lets a customer exchange it for a short-lived
// portal JWT. Auto-purged from the DB once expired.
const portalTokenSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
}, { timestamps: true });

portalTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PortalToken', portalTokenSchema);
