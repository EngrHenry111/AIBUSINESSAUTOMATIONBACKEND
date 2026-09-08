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
  password: { type: String, required: true, minlength: 8, select: false },
  role: {
    type: String,
    enum: ['super_admin', 'company_owner', 'manager', 'employee', 'customer'],
    default: 'employee',
  },
  avatar: { type: String, default: null },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  refreshToken: { type: String, select: false },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  lastLogin: { type: Date },
  loginCount: { type: Number, default: 0 },
  loginIPs: [{ ip: String, timestamp: Date }],
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date },
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
}, { timestamps: true });

userSchema.index({ companyId: 1, role: 1 });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ companyId: 1, status: 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

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
    updates.$set = { lockUntil: Date.now() + 2 * 60 * 60 * 1000 };
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