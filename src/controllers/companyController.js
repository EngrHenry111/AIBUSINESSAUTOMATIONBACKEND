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

exports.updateCompany = async (req, res, next) => {
  try {
    const allowed = ['companyName', 'industry', 'website', 'settings'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (req.file) updates.logo = req.file.path;

    const company = await Company.findByIdAndUpdate(req.companyId, updates, { new: true, runValidators: true });
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

    // Payments are configured but the store was somehow left off (e.g. it
    // was set up before store auto-enable existed) — self-heal on the way in.
    if (company.paymentSettings?.isPaymentSetup && !company.storeEnabled) {
      company.storeEnabled = true;
      dirty = true;
    }

    if (dirty) await company.save();

    const s = company.storeSettings || {};
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
      primaryColor, showOutOfStock, allowBackorders } = req.body;

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

    await company.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'store.settings_update', ip: req.ip });

    res.status(200).json({ success: true, data: { storeSlug: company.storeSlug, storeEnabled: company.storeEnabled, settings: company.storeSettings } });
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
