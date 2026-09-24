'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: {
    type: String, required: true, lowercase: true, trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
  },
  // Personal phone — used for SMS (welcome message, "new store order" /
  // "low stock" alerts to the owner, payslip notices to staff). Optional so
  // it never blocks registration or existing accounts; SMS that needs it
  // just silently no-ops (see smsService) until it's set in Settings.
  phone: { type: String, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: {
    type: String,
    enum: ['super_admin', 'company_owner', 'manager', 'employee', 'customer'],
    default: 'employee',
  },
  avatar: { type: String, default: null },
  // Organizational tag (Finance, Sales, Auditors, ...) — purely descriptive,
  // never used for permission checks. Role (above) still gates what a user
  // can do; department is just which team they're on. See utils/departments.
  department: { type: String, trim: true, maxlength: 60, default: null },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  refreshToken: { type: String, select: false },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  lastLogin: { type: Date },
  loginCount: { type: Number, default: 0 },
  loginIPs: [{ ip: String, timestamp: Date }],
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date },
  // Bumped on password change so every previously-issued JWT (which embeds
  // the version it was signed with) is rejected on its next use — the one
  // request that increments this returns a freshly-signed pair instead, so
  // that device stays logged in while every other device is forced to sign
  // in again.
  tokenVersion: { type: Number, default: 0 },
  // default true so users that predate this field are treated as verified;
  // register() explicitly sets it false for new sign-ups
  emailVerified: { type: Boolean, default: true },
  emailVerifyToken: { type: String, select: false },
  emailVerifyExpires: { type: Date, select: false },
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String, select: false },
  backupCodes: { type: [{ code: String, used: { type: Boolean, default: false } }], select: false, default: undefined },
  preferences: {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    language: { type: String, default: 'en' },
    notifications: {
      email: { type: Boolean, default: true },
      browser: { type: Boolean, default: true },
    },
  },

  // ── Digital business card (bislyai.com/card/username) ─────────────────
  cardSettings: {
    enabled: { type: Boolean, default: true },
    username: { type: String, trim: true, lowercase: true }, // globally unique, auto-generated
    tagline: { type: String, trim: true, maxlength: 150 },
    bio: { type: String, trim: true, maxlength: 500 },
    primaryColor: { type: String, default: '#6366f1' },
    template: { type: String, enum: ['modern', 'minimal', 'bold', 'elegant'], default: 'modern' },
    links: [{
      type: { type: String, enum: ['website', 'whatsapp', 'instagram', 'twitter', 'linkedin', 'facebook', 'youtube', 'tiktok', 'email', 'phone', 'custom'] },
      label: String,
      url: String,
      icon: String,
    }],
    showEmail: { type: Boolean, default: true },
    showPhone: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
  },
}, { timestamps: true });

userSchema.index({ companyId: 1, role: 1 });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ companyId: 1, status: 1 });
// Globally unique (not per-company) — the card URL is bislyai.com/card/username
// with no company in the path, so two different companies' users can never
// collide on the same handle.
userSchema.index({ 'cardSettings.username': 1 }, { unique: true, sparse: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// "Henry Akpan" -> "henry.akpan"
const slugifyUsername = (s) => String(s || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '') // strip combining diacritics
  .toLowerCase()
  .trim()
  .replace(/\s+/g, '.')
  .replace(/[^a-z0-9.]/g, '')
  .replace(/\.+/g, '.')
  .replace(/^\.+|\.+$/g, '');

const rand3 = () => String(Math.floor(Math.random() * 900) + 100); // 100-999, matches the "name123" look

/**
 * A card username from `name` that no other user has. Collisions get a
 * fresh random 3-digit suffix (never the SAME suffix retried, unlike a bare
 * `Math.random()*999` computed once — that has real collision odds once a
 * handful of people share a first+last name).
 */
async function generateCardUsername(name, excludeId) {
  const Model = this;
  const base = slugifyUsername(name) || 'user';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = `${base}${rand3()}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await Model.exists({
      'cardSettings.username': candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!clash) return candidate;
  }
  return `${base}${Date.now().toString(36)}`; // extremely unlikely fallback
}

// Auto-generate a card username for every user, on every creation path —
// register(), team invites, Google OAuth — not just one controller. Only
// ever assigned when empty, same "never reassign" guarantee Company.storeSlug
// already relies on elsewhere in this codebase.
userSchema.pre('save', async function (next) {
  try {
    if (!this.cardSettings) this.cardSettings = {};
    if (!this.cardSettings.username && this.name) {
      this.cardSettings.username = await generateCardUsername.call(this.constructor, this.name, this._id);
    }
    next();
  } catch (err) {
    next(err);
  }
});

userSchema.statics.slugifyUsername = slugifyUsername;
userSchema.statics.generateCardUsername = generateCardUsername;

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

userSchema.methods.incLoginAttempts = async function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { failedLoginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { failedLoginAttempts: 1 } };
  if (this.failedLoginAttempts + 1 >= 5) {
    updates.$set = { lockUntil: Date.now() + 60 * 60 * 1000 }; // 1 hour
  }
  return this.updateOne(updates);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password; delete obj.refreshToken;
  delete obj.passwordResetToken; delete obj.passwordResetExpires;
  delete obj.emailVerifyToken; delete obj.emailVerifyExpires;
  delete obj.twoFactorSecret; delete obj.backupCodes; delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);