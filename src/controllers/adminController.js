'use strict';

const os = require('os');
const mongoose = require('mongoose');

const User = require('../models/User');
const Company = require('../models/Company');
const Document = require('../models/Document');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const Payment = require('../models/Payment');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { checkHealth: checkEmbeddingHealth } = require('../services/embeddingService');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const PLAN_KEYS = ['trial', 'starter', 'professional', 'business', 'enterprise'];

// Monthly price in the platform's billing currency (NGN) — mirrors
// paymentController PLANS.monthlyAmount. Used to compute MRR.
const PLAN_MONTHLY = { trial: 0, starter: 4900, professional: 14900, business: 34900, enterprise: 34900 };

const PLAN_LIMITS = {
  trial: { maxUsers: 5, maxDocuments: 100, maxQuestionsPerMonth: 500 },
  starter: { maxUsers: 5, maxDocuments: 500, maxQuestionsPerMonth: 2000 },
  professional: { maxUsers: 25, maxDocuments: 2000, maxQuestionsPerMonth: 10000 },
  business: { maxUsers: 100, maxDocuments: 10000, maxQuestionsPerMonth: 50000 },
  enterprise: { maxUsers: 500, maxDocuments: 100000, maxQuestionsPerMonth: 500000 },
};

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const startOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };
const mrrOf = (companies) =>
  companies.reduce((sum, c) => sum + (PLAN_MONTHLY[c.subscription?.plan] || 0), 0);
const activePaidQuery = {
  status: 'active',
  'subscription.status': 'active',
  'subscription.plan': { $nin: ['trial', null] },
};

// ── GET /admin/stats ────────────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const today = startOfToday();
    const monthStart = startOfMonth();

    const [
      totalCompanies, activeCompanies, suspendedCompanies, newCompaniesThisMonth,
      totalUsers, newUsersToday, newUsersThisMonth,
      totalDocuments, totalChats, totalMessages,
      planAgg, revenueAgg, mrrCompanies,
      recentSignups, recentActivity, aiMsgAgg,
    ] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ status: 'active' }),
      Company.countDocuments({ status: 'suspended' }),
      Company.countDocuments({ createdAt: { $gte: monthStart } }),
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ createdAt: { $gte: monthStart } }),
      Document.countDocuments(),
      Chat.countDocuments(),
      Message.countDocuments(),
      Company.aggregate([{ $group: { _id: '$subscription.plan', count: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { status: 'success' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Company.find(activePaidQuery).select('subscription.plan').lean(),
      Company.find().populate('owner', 'name email').sort({ createdAt: -1 }).limit(10)
        .select('companyName status subscription createdAt').lean(),
      AuditLog.find().sort({ timestamp: -1 }).limit(20)
        .populate('userId', 'name email').populate('companyId', 'companyName').lean(),
      Chat.aggregate([{ $group: { _id: null, count: { $sum: { $size: { $ifNull: ['$messages', []] } } } } }]),
    ]);

    const planBreakdown = PLAN_KEYS.reduce((acc, k) => { acc[k] = 0; return acc; }, {});
    planAgg.forEach((p) => {
      const key = p._id || 'trial';
      planBreakdown[key] = (planBreakdown[key] || 0) + p.count;
    });

    res.status(200).json({
      success: true,
      data: {
        totalCompanies,
        activeCompanies,
        suspendedCompanies,
        newCompaniesThisMonth,
        totalUsers,
        newUsersToday,
        newUsersThisMonth,
        totalRevenue: revenueAgg[0]?.total || 0,
        mrr: mrrOf(mrrCompanies),
        activeSubscriptions: mrrCompanies.length,
        totalDocuments,
        totalChats,
        totalMessages,
        totalAIMessages: aiMsgAgg[0]?.count || 0,
        planBreakdown,
        recentSignups: recentSignups.map((c) => ({
          _id: c._id,
          companyName: c.companyName,
          status: c.status,
          plan: c.subscription?.plan || 'trial',
          owner: c.owner ? { name: c.owner.name, email: c.owner.email } : null,
          createdAt: c.createdAt,
        })),
        recentActivity: recentActivity.map((l) => ({
          _id: l._id,
          action: l.action,
          description: l.description,
          status: l.status,
          user: l.userId ? { name: l.userId.name, email: l.userId.email } : null,
          company: l.companyId ? l.companyId.companyName : null,
          timestamp: l.timestamp,
        })),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /admin/companies ────────────────────────────────────────────────────
exports.getCompanies = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const { status, plan, search } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (plan) filter['subscription.plan'] = plan;
    if (search && search.trim()) filter.companyName = { $regex: search.trim(), $options: 'i' };

    const [companies, total] = await Promise.all([
      Company.find(filter).populate('owner', 'name email')
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Company.countDocuments(filter),
    ]);

    const ids = companies.map((c) => c._id);
    const [userCounts, docCounts, revenueCounts] = await Promise.all([
      User.aggregate([{ $match: { companyId: { $in: ids } } }, { $group: { _id: '$companyId', n: { $sum: 1 } } }]),
      Document.aggregate([{ $match: { companyId: { $in: ids } } }, { $group: { _id: '$companyId', n: { $sum: 1 } } }]),
      Payment.aggregate([
        { $match: { companyId: { $in: ids }, status: 'success' } },
        { $group: { _id: '$companyId', total: { $sum: '$amount' } } },
      ]),
    ]);
    const uMap = Object.fromEntries(userCounts.map((x) => [String(x._id), x.n]));
    const dMap = Object.fromEntries(docCounts.map((x) => [String(x._id), x.n]));
    const rMap = Object.fromEntries(revenueCounts.map((x) => [String(x._id), x.total]));

    res.status(200).json({
      success: true,
      data: companies.map((c) => ({
        _id: c._id,
        companyName: c.companyName,
        owner: c.owner ? { _id: c.owner._id, name: c.owner.name, email: c.owner.email } : null,
        plan: c.subscription?.plan || 'trial',
        subscriptionStatus: c.subscription?.status || 'active',
        status: c.status,
        usersCount: uMap[String(c._id)] || 0,
        docsCount: dMap[String(c._id)] || 0,
        revenue: rMap[String(c._id)] || 0,
        createdAt: c.createdAt,
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) { next(err); }
};

// ── GET /admin/companies/:id ────────────────────────────────────────────────
exports.getCompany = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid company id.', 400));

    const company = await Company.findById(id).populate('owner', 'name email role lastLogin').lean();
    if (!company) return next(new AppError('Company not found.', 404));

    const oid = new mongoose.Types.ObjectId(id);
    const [team, documents, chatsCount, aiMsgAgg, payments, messagesCount] = await Promise.all([
      User.find({ companyId: id })
        .select('name email role status lastLogin loginCount createdAt').sort({ createdAt: 1 }).lean(),
      Document.find({ companyId: id })
        .select('name originalName fileType fileSize status createdAt').sort({ createdAt: -1 }).limit(100).lean(),
      Chat.countDocuments({ companyId: id }),
      Chat.aggregate([
        { $match: { companyId: oid } },
        { $group: { _id: null, n: { $sum: { $size: { $ifNull: ['$messages', []] } } } } },
      ]),
      Payment.find({ companyId: id }).sort({ paidAt: -1 }).limit(50).lean(),
      Message.countDocuments({ companyId: id }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        company: {
          _id: company._id,
          companyName: company.companyName,
          industry: company.industry,
          website: company.website,
          slug: company.slug,
          status: company.status,
          subscription: company.subscription,
          settings: company.settings,
          usage: company.usage,
          limits: company.limits,
          owner: company.owner,
          createdAt: company.createdAt,
          updatedAt: company.updatedAt,
        },
        team,
        documents,
        payments,
        stats: {
          teamCount: team.length,
          documentsCount: documents.length,
          chatsCount,
          aiMessagesCount: aiMsgAgg[0]?.n || 0,
          messagesCount,
          totalRevenue: payments
            .filter((p) => p.status === 'success')
            .reduce((s, p) => s + p.amount, 0),
        },
      },
    });
  } catch (err) { next(err); }
};

// ── GET /admin/users ────────────────────────────────────────────────────────
exports.getUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const { search, role, status } = req.query;

    const filter = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search && search.trim()) {
      const rx = { $regex: search.trim(), $options: 'i' };
      filter.$or = [{ name: rx }, { email: rx }];
    }

    const [users, total] = await Promise.all([
      User.find(filter).populate('companyId', 'companyName')
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: users.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        company: u.companyId ? u.companyId.companyName : null,
        companyId: u.companyId?._id || null,
        lastLogin: u.lastLogin,
        loginCount: u.loginCount || 0,
        createdAt: u.createdAt,
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) { next(err); }
};

// ── GET /admin/revenue ──────────────────────────────────────────────────────
exports.getRevenue = async (req, res, next) => {
  try {
    const monthStart = startOfMonth();
    const seriesStart = new Date();
    seriesStart.setMonth(seriesStart.getMonth() - 5);
    seriesStart.setDate(1);
    seriesStart.setHours(0, 0, 0, 0);

    const [allTime, thisMonth, byPlan, monthly, recent, mrrCompanies] = await Promise.all([
      Payment.aggregate([
        { $match: { status: 'success' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'success', paidAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'success' } },
        { $group: { _id: '$plan', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'success', paidAt: { $gte: seriesStart } } },
        { $group: { _id: { y: { $year: '$paidAt' }, m: { $month: '$paidAt' } }, total: { $sum: '$amount' } } },
      ]),
      Payment.find().populate('companyId', 'companyName').sort({ paidAt: -1 }).limit(20).lean(),
      Company.find(activePaidQuery).select('subscription.plan').lean(),
    ]);

    // Dense 6-month trend, zero-filled
    const trend = [];
    const cursor = new Date(seriesStart);
    for (let i = 0; i < 6; i++) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth() + 1;
      const hit = monthly.find((x) => x._id.y === y && x._id.m === m);
      trend.push({
        month: cursor.toLocaleDateString('en-US', { month: 'short' }),
        year: y,
        revenue: hit?.total || 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: allTime[0]?.total || 0,
        totalTransactions: allTime[0]?.count || 0,
        revenueThisMonth: thisMonth[0]?.total || 0,
        mrr: mrrOf(mrrCompanies),
        activeSubscriptions: mrrCompanies.length,
        revenueByPlan: PLAN_KEYS.filter((k) => k !== 'trial').map((k) => {
          const hit = byPlan.find((x) => x._id === k);
          return { plan: k, revenue: hit?.total || 0, transactions: hit?.count || 0 };
        }),
        trend,
        recentTransactions: recent.map((p) => ({
          _id: p._id,
          reference: p.reference,
          amount: p.amount,
          currency: p.currency,
          plan: p.plan,
          billingCycle: p.billingCycle,
          status: p.status,
          company: p.companyId ? p.companyId.companyName : null,
          paidAt: p.paidAt,
        })),
      },
    });
  } catch (err) { next(err); }
};

// ── PATCH /admin/companies/:id/suspend ──────────────────────────────────────
exports.suspendCompany = async (req, res, next) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { status: 'suspended', 'subscription.status': 'suspended' },
      { new: true }
    );
    if (!company) return next(new AppError('Company not found.', 404));
    writeAuditLog({
      companyId: company._id, userId: req.user._id, action: 'admin.company.suspend',
      description: `Suspended company ${company.companyName}`, ip: req.ip,
    });
    logger.warn(`Admin ${req.user.email} suspended company ${company.companyName}`);
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
};

// ── PATCH /admin/companies/:id/activate ─────────────────────────────────────
exports.activateCompany = async (req, res, next) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { status: 'active', 'subscription.status': 'active' },
      { new: true }
    );
    if (!company) return next(new AppError('Company not found.', 404));
    writeAuditLog({
      companyId: company._id, userId: req.user._id, action: 'admin.company.activate',
      description: `Reactivated company ${company.companyName}`, ip: req.ip,
    });
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
};

// ── PATCH /admin/companies/:id/plan ─────────────────────────────────────────
exports.changePlan = async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!PLAN_KEYS.includes(plan)) return next(new AppError('Invalid plan.', 400));

    const limits = PLAN_LIMITS[plan];
    const update = {
      'subscription.plan': plan,
      'subscription.status': 'active',
      'limits.maxUsers': limits.maxUsers,
      'limits.maxDocuments': limits.maxDocuments,
      'limits.maxQuestionsPerMonth': limits.maxQuestionsPerMonth,
    };
    if (plan !== 'trial') {
      const end = new Date();
      end.setMonth(end.getMonth() + 1);
      update['subscription.currentPeriodStart'] = new Date();
      update['subscription.currentPeriodEnd'] = end;
    }

    const company = await Company.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!company) return next(new AppError('Company not found.', 404));
    writeAuditLog({
      companyId: company._id, userId: req.user._id, action: 'admin.company.plan',
      description: `Changed ${company.companyName} plan to ${plan}`, ip: req.ip,
    });
    res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
};

// ── POST /admin/broadcast ──────────────────────────────────────────────────
exports.broadcast = async (req, res, next) => {
  try {
    const { subject, message } = req.body;
    if (!subject?.trim() || !message?.trim()) {
      return next(new AppError('Subject and message are required.', 400));
    }

    const owners = await User.find({ role: 'company_owner', status: 'active' })
      .select('name email').lean();

    let sent = 0;
    let failed = 0;
    for (const owner of owners) {
      try {
        await emailService.sendBroadcast(owner.email, owner.name, subject.trim(), message.trim());
        sent++;
      } catch (err) {
        failed++;
        logger.warn(`Broadcast to ${owner.email} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 60)); // gentle on the SMTP provider
    }

    writeAuditLog({
      userId: req.user._id, action: 'admin.broadcast',
      description: `Broadcast "${subject.trim()}" → ${sent}/${owners.length} owners`, ip: req.ip,
    });

    res.status(200).json({ success: true, data: { recipients: owners.length, sent, failed } });
  } catch (err) { next(err); }
};

// ── GET /admin/health ──────────────────────────────────────────────────────
exports.getHealth = async (req, res, next) => {
  try {
    const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const dbState = mongoose.connection.readyState;

    let embeddingUp = false;
    try { embeddingUp = await checkEmbeddingHealth(); } catch { embeddingUp = false; }

    const mem = process.memoryUsage();
    const errorLogs = await AuditLog.find({ status: 'failure' })
      .sort({ timestamp: -1 }).limit(20)
      .populate('userId', 'name email').populate('companyId', 'companyName').lean();

    res.status(200).json({
      success: true,
      data: {
        database: {
          status: dbStates[dbState] || 'unknown',
          healthy: dbState === 1,
          host: mongoose.connection.host || null,
          name: mongoose.connection.name || null,
        },
        embeddingService: {
          status: embeddingUp ? 'operational' : 'unavailable',
          healthy: embeddingUp,
          url: process.env.EMBEDDING_SERVICE_URL || null,
        },
        server: {
          uptimeSeconds: Math.floor(process.uptime()),
          nodeVersion: process.version,
          environment: process.env.NODE_ENV || 'development',
          platform: process.platform,
        },
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          systemTotal: os.totalmem(),
          systemFree: os.freemem(),
        },
        errorLogs: errorLogs.map((l) => ({
          _id: l._id,
          action: l.action,
          description: l.description,
          user: l.userId ? l.userId.name : null,
          company: l.companyId ? l.companyId.companyName : null,
          timestamp: l.timestamp,
        })),
      },
    });
  } catch (err) { next(err); }
};

// ── GET /admin/audit-logs (kept for backward compatibility) ─────────────────
exports.getAuditLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const filter = req.query.companyId ? { companyId: req.query.companyId } : {};

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('userId', 'name email').populate('companyId', 'companyName').lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, data: logs, pagination: { total, page, limit } });
  } catch (err) { next(err); }
};
