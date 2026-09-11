'use strict';

const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  companyName: { type: String, required: true, trim: true, maxlength: 200 },
  slug: { type: String, lowercase: true },
  industry: { type: String, trim: true },
  website: { type: String, trim: true },
  logo: { type: String },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // ── Business profile — feeds invoices, AI reminders, the storefront and
  // the customer portal, so it's kept separate from the owner's own contact
  // details (settings.timezone/currency etc. stay app-level preferences).
  profile: {
    tagline: { type: String, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true },     // shown on invoices, distinct from the owner's login email
    phone: { type: String, trim: true },
    address: { type: String, trim: true, maxlength: 400 },
    rcNumber: { type: String, trim: true },                    // business registration number
    tin: { type: String, trim: true },                         // tax identification number
    socials: {
      twitter: { type: String, trim: true },
      facebook: { type: String, trim: true },
      instagram: { type: String, trim: true },
      linkedin: { type: String, trim: true },
      whatsapp: { type: String, trim: true },
    },
  },
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

// "WebTech Solutions" -> "webtech-solutions"
const slugify = (s) => String(s || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
  .toLowerCase()
  .replace(/[\s_]+/g, '-')           // spaces / underscores -> hyphen
  .replace(/[^a-z0-9-]/g, '')        // remove any other special character
  .replace(/-+/g, '-')               // collapse runs of hyphens
  .replace(/^-+|-+$/g, '');          // trim leading/trailing hyphens

// 4 lowercase-alphanumeric characters, e.g. "x7k2"
const rand4 = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 4; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

/**
 * A store slug from `name` that no other company uses.
 * On collision, append a random 4-char suffix ("webtech" → "webtech-x7k2").
 */
async function generateStoreSlug(name, excludeId) {
  const Model = this;
  const base = slugify(name) || `store-${rand4()}`;
  let candidate = base;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const clash = await Model.exists({
      storeSlug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!clash) return candidate;
    candidate = `${base}-${rand4()}`;
  }
  return `${base}-${Date.now().toString(36)}`; // extremely unlikely fallback
}

// Auto-generate slugs from company name
companySchema.pre('save', async function (next) {
  try {
    if (this.isModified('companyName') && !this.slug) {
      this.slug = `${slugify(this.companyName)}-${Date.now().toString(36)}`;
    }
    // Only ever assign when empty — never reassign an existing store slug.
    if (!this.storeSlug && this.companyName) {
      this.storeSlug = await generateStoreSlug.call(this.constructor, this.companyName, this._id);
    }
    next();
  } catch (err) {
    next(err);
  }
});

companySchema.statics.slugify = slugify;
companySchema.statics.generateStoreSlug = generateStoreSlug;

module.exports = mongoose.model('Company', companySchema);

