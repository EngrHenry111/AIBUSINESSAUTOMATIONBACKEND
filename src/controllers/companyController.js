'use strict';

const fs = require('fs');
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { cloudinary } = require('../config/cloudinary');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

exports.getCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).populate('owner', 'name email avatar');
    if (!company) return next(new AppError('Company not found.', 404));
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
};

// Fields nested under `profile` that a client may update — merged in,
// never replacing the whole subdocument, so a partial PATCH can't wipe
// fields it didn't send.
const PROFILE_FIELDS = ['tagline', 'email', 'phone', 'address', 'rcNumber', 'tin'];
const SOCIAL_FIELDS = ['twitter', 'facebook', 'instagram', 'linkedin', 'whatsapp'];

exports.updateCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    const allowed = ['companyName', 'industry', 'website', 'settings', 'defaultCurrency', 'supportedCurrencies'];
    allowed.forEach((f) => { if (req.body[f] !== undefined) company[f] = req.body[f]; });

    // `profile` may arrive as a JSON string (multipart form) or an object
    let profileInput = req.body.profile;
    if (typeof profileInput === 'string') {
      try { profileInput = JSON.parse(profileInput); } catch { profileInput = undefined; }
    }
    if (profileInput && typeof profileInput === 'object') {
      if (!company.profile) company.profile = {};
      PROFILE_FIELDS.forEach((f) => { if (profileInput[f] !== undefined) company.profile[f] = profileInput[f]; });
      if (profileInput.socials && typeof profileInput.socials === 'object') {
        if (!company.profile.socials) company.profile.socials = {};
        SOCIAL_FIELDS.forEach((f) => { if (profileInput.socials[f] !== undefined) company.profile.socials[f] = profileInput.socials[f]; });
      }
    }

    // Logo upload (multipart, field name "logo") → Cloudinary, matching how
    // product images / the store banner are handled elsewhere.
    if (req.file) {
      if (cloudinary) {
        const r = await cloudinary.uploader.upload(req.file.path, {
          folder: `business-ai/${req.companyId}/branding`,
          resource_type: 'image',
          transformation: [{ width: 500, height: 500, crop: 'limit' }],
        });
        fs.unlink(req.file.path, () => {});
        company.logo = r.secure_url;
      } else {
        company.logo = `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${req.file.path.split(/[\\/]/).pop()}`;
      }
    }

    await company.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'company.update', ip: req.ip });
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
};

exports.getUsage = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('usage limits subscription');
    if (!company) return next(new AppError('Company not found.', 404));

    const usagePercentages = {
      documents: company.limits.maxDocuments > 0 ? Math.round((company.usage.documentsCount / company.limits.maxDocuments) * 100) : 0,
      storage: company.limits.maxStorage > 0 ? Math.round((company.usage.storageUsed / company.limits.maxStorage) * 100) : 0,
      questions: company.limits.maxQuestionsPerMonth > 0 ? Math.round((company.usage.questionsAsked / company.limits.maxQuestionsPerMonth) * 100) : 0,
    };

    res.status(200).json({ success: true, data: { usage: company.usage, limits: company.limits, subscription: company.subscription, percentages: usagePercentages } });
  } catch (err) { next(err); }
};

// ── GET /companies/store ─────────────────────────────────────────────
exports.getStoreSettings = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    let dirty = false;

    // Backfill a slug for companies created before the storefront existed.
    // Only assign when it's still empty — never touch an existing store slug.
    if (!company.storeSlug) {
      company.storeSlug = await Company.generateStoreSlug(company.companyName, company._id);
      dirty = true;
    }

    // A store with a slug should be reachable from day one — payment setup
    // only gates checkout, not the store page existing. Self-heal any
    // company that was left disabled (e.g. registered before this existed).
    if (!company.storeEnabled) {
      company.storeEnabled = true;
      dirty = true;
    }

    if (dirty) await company.save();

    const s = company.storeSettings || {};
    const d = company.deliverySettings || {};
    res.status(200).json({
      success: true,
      data: {
        storeSlug: company.storeSlug,
        storeEnabled: Boolean(company.storeEnabled),
        storeUrl: `${(process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '')}/store/${company.storeSlug}`,
        paymentReady: Boolean(company.paymentSettings?.isPaymentSetup),
        settings: {
          banner: s.banner || null,
          description: s.description || '',
          announcement: s.announcement || '',
          primaryColor: s.primaryColor || '#6366f1',
          showOutOfStock: s.showOutOfStock !== false,
          allowBackorders: Boolean(s.allowBackorders),
        },
        deliverySettings: {
          feesByState: d.feesByState ? Object.fromEntries(d.feesByState) : {},
          defaultFee: d.defaultFee ?? 2000,
          freeDeliveryMinimum: d.freeDeliveryMinimum ?? null,
          estimatedDeliveryDays: d.estimatedDeliveryDays ?? 3,
          podEnabled: Boolean(d.podEnabled),
          podMaxAmount: d.podMaxAmount ?? 50000,
        },
        giftCardSettings: {
          enabled: company.giftCardSettings?.enabled !== false,
          minAmount: company.giftCardSettings?.minAmount ?? 500,
          maxAmount: company.giftCardSettings?.maxAmount ?? 500000,
          expiryDays: company.giftCardSettings?.expiryDays ?? 365,
        },
        marketplace: {
          category: company.marketplace?.category || 'Other',
          location: company.marketplace?.location || '',
          tags: company.marketplace?.tags || [],
          // Verified/featured are platform-granted, not self-service — shown
          // read-only here, never settable via this endpoint.
          isVerified: Boolean(company.marketplace?.isVerified),
          isFeatured: Boolean(company.marketplace?.isFeatured),
        },
      },
    });
  } catch (err) { next(err); }
};

// ── PUT /companies/store ─────────────────────────────────────────────
exports.updateStoreSettings = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    const { storeSlug, storeEnabled, description, announcement, banner,
      primaryColor, showOutOfStock, allowBackorders, deliverySettings, giftCardSettings, marketplace } = req.body;

    if (storeSlug !== undefined) {
      const slug = String(storeSlug).toLowerCase().trim();
      if (!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 60) {
        return next(new AppError('Store link can only use lowercase letters, numbers and hyphens (3–60 chars).', 400));
      }
      if (slug !== company.storeSlug) {
        const taken = await Company.exists({ storeSlug: slug, _id: { $ne: company._id } });
        if (taken) return next(new AppError('That store link is already taken.', 409));
        company.storeSlug = slug;
      }
    }

    if (storeEnabled !== undefined) {
      if (storeEnabled && !company.paymentSettings?.isPaymentSetup) {
        return next(new AppError('Set up payments before enabling your store.', 400));
      }
      company.storeEnabled = Boolean(storeEnabled);
    }

    if (!company.storeSettings) company.storeSettings = {};
    if (description !== undefined) company.storeSettings.description = String(description).slice(0, 1000);
    if (announcement !== undefined) company.storeSettings.announcement = String(announcement).slice(0, 300);
    if (banner !== undefined) company.storeSettings.banner = banner || null;
    if (primaryColor !== undefined) company.storeSettings.primaryColor = /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : company.storeSettings.primaryColor;
    if (showOutOfStock !== undefined) company.storeSettings.showOutOfStock = Boolean(showOutOfStock);
    if (allowBackorders !== undefined) company.storeSettings.allowBackorders = Boolean(allowBackorders);

    if (deliverySettings && typeof deliverySettings === 'object') {
      if (!company.deliverySettings) company.deliverySettings = {};
      const ds = deliverySettings;
      if (ds.feesByState && typeof ds.feesByState === 'object') {
        company.deliverySettings.feesByState = new Map(
          Object.entries(ds.feesByState).map(([state, fee]) => [state, Number(fee) || 0])
        );
      }
      if (ds.defaultFee !== undefined) company.deliverySettings.defaultFee = Number(ds.defaultFee) || 0;
      if (ds.freeDeliveryMinimum !== undefined) company.deliverySettings.freeDeliveryMinimum = ds.freeDeliveryMinimum === '' || ds.freeDeliveryMinimum == null ? null : Number(ds.freeDeliveryMinimum);
      if (ds.estimatedDeliveryDays !== undefined) company.deliverySettings.estimatedDeliveryDays = Number(ds.estimatedDeliveryDays) || 3;
      if (ds.podEnabled !== undefined) company.deliverySettings.podEnabled = Boolean(ds.podEnabled);
      if (ds.podMaxAmount !== undefined) company.deliverySettings.podMaxAmount = Number(ds.podMaxAmount) || 0;
      if (ds.defaultProvider !== undefined && ['gig', 'kwik', 'sendbox', 'manual'].includes(ds.defaultProvider)) {
        company.deliverySettings.defaultProvider = ds.defaultProvider;
      }
      if (ds.manualTrackingUrlFormat !== undefined) company.deliverySettings.manualTrackingUrlFormat = String(ds.manualTrackingUrlFormat).slice(0, 300) || undefined;
    }

    if (giftCardSettings && typeof giftCardSettings === 'object') {
      if (!company.giftCardSettings) company.giftCardSettings = {};
      const gcs = giftCardSettings;
      if (gcs.enabled !== undefined) company.giftCardSettings.enabled = Boolean(gcs.enabled);
      if (gcs.minAmount !== undefined) company.giftCardSettings.minAmount = Math.max(100, Number(gcs.minAmount) || 500);
      if (gcs.maxAmount !== undefined) company.giftCardSettings.maxAmount = Number(gcs.maxAmount) || 500000;
      if (gcs.expiryDays !== undefined) company.giftCardSettings.expiryDays = Math.max(1, Number(gcs.expiryDays) || 365);
    }

    if (marketplace && typeof marketplace === 'object') {
      if (!company.marketplace) company.marketplace = {};
      const MARKETPLACE_CATEGORIES = ['Fashion', 'Food', 'Electronics', 'Beauty', 'Home', 'Services', 'Agriculture', 'Other'];
      if (marketplace.category !== undefined && MARKETPLACE_CATEGORIES.includes(marketplace.category)) {
        company.marketplace.category = marketplace.category;
      }
      if (marketplace.location !== undefined) company.marketplace.location = String(marketplace.location).slice(0, 100);
      if (Array.isArray(marketplace.tags)) company.marketplace.tags = marketplace.tags.slice(0, 15).map((t) => String(t).slice(0, 30));
      // isVerified/isFeatured are deliberately not settable here — see getStoreSettings.
    }

    await company.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'store.settings_update', ip: req.ip });

    res.status(200).json({
      success: true,
      data: {
        storeSlug: company.storeSlug,
        storeEnabled: company.storeEnabled,
        settings: company.storeSettings,
        deliverySettings: company.deliverySettings ? {
          ...company.deliverySettings.toObject?.() ?? company.deliverySettings,
          feesByState: company.deliverySettings.feesByState ? Object.fromEntries(company.deliverySettings.feesByState) : {},
        } : null,
        giftCardSettings: company.giftCardSettings || null,
        marketplace: company.marketplace || null,
      },
    });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('That store link is already taken.', 409));
    next(err);
  }
};

// ── POST /companies/store/banner ────────────────────────────────────
exports.uploadStoreBanner = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No image received.', 400));
    let url;
    if (cloudinary) {
      const r = await cloudinary.uploader.upload(req.file.path, {
        folder: `business-ai/${req.companyId}/store`,
        resource_type: 'image',
        transformation: [{ width: 1600, height: 500, crop: 'limit' }],
      });
      fs.unlink(req.file.path, () => {});
      url = r.secure_url;
    } else {
      url = `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${req.file.path.split(/[\\/]/).pop()}`;
    }

    const company = await Company.findById(req.companyId);
    if (!company.storeSettings) company.storeSettings = {};
    company.storeSettings.banner = url;
    await company.save();
    res.status(200).json({ success: true, data: { banner: url } });
  } catch (err) { next(err); }
};

// ── GET /companies/store/analytics ─────────────────────────────────
exports.getStoreAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const match = { companyId, source: 'storefront' };

    const [agg, topProducts, recent] = await Promise.all([
      Order.aggregate([
        { $match: match },
        { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: match },
        { $unwind: '$items' },
        { $group: {
          _id: { $ifNull: ['$items.productId', '$items.name'] },
          name: { $first: '$items.name' },
          units: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        } },
        { $sort: { units: -1 } },
        { $limit: 5 },
      ]),
      Order.find(match).sort({ createdAt: -1 }).limit(10)
        .select('orderNumber customer total currency status createdAt').lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: agg[0]?.revenue || 0,
        totalOrders: agg[0]?.orders || 0,
        topProducts: topProducts.map((p) => ({ name: p.name, units: p.units, revenue: p.revenue })),
        recentOrders: recent,
      },
    });
  } catch (err) { next(err); }
};

exports.updateAISettings = async (req, res, next) => {
  try {
    const { aiModel, confidenceThreshold, requireApprovalForActions } = req.body;
    const updates = {};
    if (aiModel) updates['settings.aiModel'] = aiModel;
    if (confidenceThreshold !== undefined) updates['settings.confidenceThreshold'] = confidenceThreshold;
    if (requireApprovalForActions !== undefined) updates['settings.requireApprovalForActions'] = requireApprovalForActions;

    const company = await Company.findByIdAndUpdate(req.companyId, updates, { new: true });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'company.ai_settings_update', ip: req.ip });
    res.status(200).json({ success: true, data: company.settings });
  } catch (err) { next(err); }
};

// ── PATCH /companies/sms-settings ───────────────────────────────────────
const SMS_TOGGLE_FIELDS = ['enabled', 'sendInvoiceSMS', 'sendOrderSMS', 'sendPayrollSMS', 'sendLowStockSMS'];
exports.updateSMSSettings = async (req, res, next) => {
  try {
    const updates = {};
    SMS_TOGGLE_FIELDS.forEach((f) => { if (req.body[f] !== undefined) updates[`smsSettings.${f}`] = Boolean(req.body[f]); });

    const company = await Company.findByIdAndUpdate(req.companyId, updates, { new: true }).select('smsSettings');
    if (!company) return next(new AppError('Company not found.', 404));
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'company.sms_settings_update', ip: req.ip });
    res.status(200).json({ success: true, data: company.smsSettings });
  } catch (err) { next(err); }
};

// ── POST /companies/test-sms ──────────────────────────────────────────
// Owner-facing test (any manager+, unlike /admin/test-sms which is
// super_admin-only and can target an arbitrary number) — sends to the
// caller's own registered phone unless one is explicitly supplied, so
// there's no way to use this to blast an arbitrary third-party number.
exports.testSMS = async (req, res, next) => {
  try {
    const phone = req.body.phone || req.user.phone;
    if (!phone) {
      return next(new AppError('Add a phone number to your profile first (Settings → Profile).', 400));
    }
    const { sendSMS } = require('../services/smsService');
    const result = await sendSMS({ to: phone, message: 'BizlyAI SMS test — working perfectly! 🎉' });
    if (!result) {
      return next(new AppError('SMS could not be sent. Check the phone number, or that SMS is configured on the server.', 502));
    }
    res.status(200).json({ success: true, message: `Test SMS sent to ${phone}` });
  } catch (err) { next(err); }
};

// ── Departments — organizational tags for team members (Finance, Sales,
// Auditors, ...), separate from role (which still gates permissions). The
// standard list in utils/departments.js is free for every company; adding a
// new CUSTOM one is owner-only, same reasoning as role changes — anyone
// could otherwise invent an unlimited number of departments. ──────────────
const { DEFAULT_DEPARTMENTS } = require('../utils/departments');

// ── GET /companies/departments ───────────────────────────────────────────
exports.getDepartments = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('departments');
    res.status(200).json({
      success: true,
      data: { standard: DEFAULT_DEPARTMENTS, custom: company.departments || [] },
    });
  } catch (err) { next(err); }
};

// ── POST /companies/departments (owner-only) ─────────────────────────────
exports.addDepartment = async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 60) return next(new AppError('Enter a department name (up to 60 characters).', 400));

    const company = await Company.findById(req.companyId).select('departments');
    const all = [...DEFAULT_DEPARTMENTS, ...(company.departments || [])];
    if (all.some((d) => d.toLowerCase() === name.toLowerCase())) {
      return next(new AppError('That department already exists.', 409));
    }
    if (company.departments.length >= 30) {
      return next(new AppError('Maximum of 30 custom departments reached.', 400));
    }

    company.departments.push(name);
    await company.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'company.department_add', description: `Added department "${name}"`, ip: req.ip });

    res.status(201).json({ success: true, data: { standard: DEFAULT_DEPARTMENTS, custom: company.departments } });
  } catch (err) { next(err); }
};

// ── DELETE /companies/departments/:name (owner-only) ─────────────────────
exports.deleteDepartment = async (req, res, next) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (DEFAULT_DEPARTMENTS.some((d) => d.toLowerCase() === name.toLowerCase())) {
      return next(new AppError('Standard departments cannot be removed.', 400));
    }

    const company = await Company.findById(req.companyId).select('departments');
    const before = company.departments.length;
    company.departments = company.departments.filter((d) => d.toLowerCase() !== name.toLowerCase());
    if (company.departments.length === before) return next(new AppError('Department not found.', 404));
    await company.save();

    // Unassign anyone currently tagged with it — a deleted department left
    // dangling on a user record would fail updateMemberDepartment's own
    // validity check the next time anyone tried to edit them. Exact match is
    // safe here (no regex/case-fold needed): a user's `department` is only
    // ever set from this same company.departments list, so casing already
    // matches whatever was stored.
    await User.updateMany({ companyId: req.companyId, department: name }, { department: null });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'company.department_remove', description: `Removed department "${name}"`, ip: req.ip });

    res.status(200).json({ success: true, data: { standard: DEFAULT_DEPARTMENTS, custom: company.departments } });
  } catch (err) { next(err); }
};
