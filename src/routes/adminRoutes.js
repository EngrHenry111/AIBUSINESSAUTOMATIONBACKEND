'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { isSuperAdmin } = require('../middleware/roleMiddleware');
const User = require('../models/User');
const Company = require('../models/Company');
const AuditLog = require('../models/AuditLog');
const Document = require('../models/Document');
const Chat = require('../models/Chat');
const router = express.Router();

router.use(protect, isSuperAdmin);

// ── Stats overview
router.get('/stats', async (req, res, next) => {
  try {
    const [totalCompanies, activeCompanies, totalUsers, totalDocs, totalChats,
      planBreakdown, recentCompanies] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ status: 'active' }),
      User.countDocuments(),
      Document.countDocuments(),
      Chat.countDocuments(),
      Company.aggregate([{ $group: { _id: '$subscription.plan', count: { $sum: 1 } } }]),
      Company.find().populate('owner', 'name email').sort({ createdAt: -1 }).limit(5).select('companyName status subscription createdAt'),
    ]);
    res.status(200).json({ success: true, data: {
      totalCompanies, activeCompanies, totalUsers, totalDocs, totalChats,
      planBreakdown: planBreakdown.reduce((acc, p) => { acc[p._id || 'trial'] = p.count; return acc; }, {}),
      recentCompanies,
    }});
  } catch (err) { next(err); }
});

// ── All companies
router.get('/companies', async (req, res, next) => {
  try {
    const { status, plan, page = 1, limit = 20, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (plan) filter['subscription.plan'] = plan;
    if (search) filter.companyName = { $regex: search, $options: 'i' };
    const [companies, total] = await Promise.all([
      Company.find(filter).populate('owner', 'name email').sort({ createdAt: -1 })
        .skip((page - 1) * limit).limit(Number(limit)),
      Company.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: companies, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
});

// ── All users
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const [users, total] = await Promise.all([
      User.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      User.countDocuments(),
    ]);
    res.status(200).json({ success: true, data: users, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
});

// ── Audit logs
router.get('/audit-logs', async (req, res, next) => {
  try {
    const { companyId, page = 1, limit = 50 } = req.query;
    const filter = companyId ? { companyId } : {};
    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit)
        .limit(Number(limit)).populate('userId', 'name email'),
      AuditLog.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: logs, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
});

// ── Suspend / reactivate company
router.patch('/companies/:id/suspend', async (req, res, next) => {
  try {
    const company = await Company.findByIdAndUpdate(req.params.id, { status: 'suspended' }, { new: true });
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
});

router.patch('/companies/:id/activate', async (req, res, next) => {
  try {
    const company = await Company.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
});

// ── Update company plan manually
router.patch('/companies/:id/plan', async (req, res, next) => {
  try {
    const { plan } = req.body;
    const company = await Company.findByIdAndUpdate(req.params.id,
      { 'subscription.plan': plan, 'subscription.status': 'active' },
      { new: true }
    );
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
});

module.exports = router;
