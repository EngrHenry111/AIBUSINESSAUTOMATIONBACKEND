'use strict';

const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  companyName: { type: String, required: true, trim: true, maxlength: 200 },
  slug: { type: String, lowercase: true },
  industry: { type: String, trim: true },
  website: { type: String, trim: true },
  logo: { type: String },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subscription: {
    plan: { type: String, enum: ['trial', 'starter', 'professional', 'business', 'enterprise'], default: 'trial' },
    status: { type: String, enum: ['active', 'inactive', 'past_due', 'cancelled', 'expired'], default: 'active' },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    paystackCustomerId: String,
    paystackCustomerCode: String,
    paystackSubscriptionCode: String,
    paystackEmailToken: String,
    paystackPlanCode: String,
    stripeCustomerId: String,
    stripeSubscriptionId: String,
  },
  settings: {
    timezone: { type: String, default: 'UTC' },
    currency: { type: String, default: 'USD' },
    language: { type: String, default: 'en' },
    aiModel: { type: String, default: 'llama-3.1-8b-instant' },
    confidenceThreshold: { type: Number, default: 0.3, min: 0, max: 1 },
    requireApprovalForActions: { type: Boolean, default: true },
    maxDocumentSize: { type: Number, default: 50 * 1024 * 1024 },
    allowedFileTypes: { type: [String], default: ['pdf', 'docx', 'txt'] },
  },
  usage: {
    documentsCount: { type: Number, default: 0 },
    chunksCount: { type: Number, default: 0 },
    questionsAsked: { type: Number, default: 0 },
    agentExecutions: { type: Number, default: 0 },
    storageUsed: { type: Number, default: 0 },
  },
  limits: {
    maxUsers: { type: Number, default: 5 },
    maxDocuments: { type: Number, default: 100 },
    maxStorage: { type: Number, default: 1 * 1024 * 1024 * 1024 }, // 1GB
    maxQuestionsPerMonth: { type: Number, default: 500 },
  },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },

  // ── Paystack subaccount (storefront payouts, BizlyAI keeps a commission) ──
  paymentSettings: {
    paystackSubaccountCode: String, // ACCT_xxxxxxxx
    paystackSubaccountId: String,
    bankName: String,
    bankCode: String,
    accountNumber: String,
    accountName: String, // auto-verified by Paystack
    isPaymentSetup: { type: Boolean, default: false },
    commissionPercent: { type: Number, default: 3 },
    settlementSchedule: { type: String, default: 'auto' },
  },

  // ── Public customer storefront ──────────────────────────────────────────
  storeSlug: { type: String, lowercase: true, trim: true },
  storeEnabled: { type: Boolean, default: false },
  storeSettings: {
    banner: String, // Cloudinary URL
    description: String,
    announcement: String,
    primaryColor: { type: String, default: '#6366f1' },
    showOutOfStock: { type: Boolean, default: true },
    allowBackorders: { type: Boolean, default: false },
  },
}, { timestamps: true });

companySchema.index({ slug: 1 });
companySchema.index({ storeSlug: 1 }, { unique: true, sparse: true });
companySchema.index({ owner: 1 });
companySchema.index({ 'subscription.status': 1 });

const slugify = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Auto-generate slugs from company name
companySchema.pre('save', function (next) {
  if (this.isModified('companyName') && !this.slug) {
    this.slug = `${slugify(this.companyName)}-${Date.now().toString(36)}`;
  }
  if (!this.storeSlug && this.companyName) {
    this.storeSlug = slugify(this.companyName) || `store-${Date.now().toString(36)}`;
  }
  next();
});

companySchema.statics.slugify = slugify;

module.exports = mongoose.model('Company', companySchema);

