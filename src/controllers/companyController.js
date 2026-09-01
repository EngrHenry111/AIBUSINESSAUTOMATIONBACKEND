'use strict';

const Company = require('../models/Company');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

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
