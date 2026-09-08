'use strict';

const Company = require('../models/Company');
const User = require('../models/User');
const Document = require('../models/Document');
const Chat = require('../models/Chat');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Appointment = require('../models/Appointment');
const AuditLog = require('../models/AuditLog');
const { generateStructured } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');
const cache = require('../utils/cache');

// Drop a company's cached dashboard — call after a lead/invoice/order changes
const invalidateDashboard = (companyId) => cache.del(`dashboard_${companyId}`);
exports.invalidateDashboard = invalidateDashboard;

exports.getDashboardMetrics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const cacheKey = `dashboard_${companyId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, data: cached, cached: true });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      company,
      totalDocs, docsThisMonth,
      totalChats, chatsThisMonth,
      leads, leadsThisMonth,
      invoices,
      upcomingAppointments,
      recentActivity,
      productAgg,
    ] = await Promise.all([
      Company.findById(companyId).select('usage limits subscription'),
      Document.countDocuments({ companyId, status: 'ready' }),
      Document.countDocuments({ companyId, status: 'ready', createdAt: { $gte: startOfMonth } }),
      Chat.countDocuments({ companyId }),
      Chat.countDocuments({ companyId, createdAt: { $gte: startOfMonth } }),
      Lead.aggregate([
        { $match: { companyId } },
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),
      Lead.countDocuments({ companyId, createdAt: { $gte: startOfMonth } }),
      Invoice.aggregate([
        { $match: { companyId } },
        { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
      ]),
      Appointment.countDocuments({ companyId, scheduledAt: { $gte: now }, status: 'confirmed' }),
      AuditLog.find({ companyId }).sort({ timestamp: -1 }).limit(10).populate('userId', 'name avatar'),
      Product.aggregate([
        { $match: { companyId } },
        { $group: {
          _id: null,
          total: { $sum: { $cond: [{ $ne: ['$status', 'inactive'] }, 1, 0] } },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          outOfStock: { $sum: { $cond: [{ $eq: ['$status', 'out_of_stock'] }, 1, 0] } },
          lowStock: { $sum: { $cond: [{ $and: [
            { $ne: ['$status', 'inactive'] },
            { $eq: ['$stock.trackStock', true] },
            { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] },
          ] }, 1, 0] } },
        } },
      ]),
    ]);

    // Lead pipeline stats
    const leadStats = leads.reduce((acc, l) => {
      acc[l._id] = { count: l.count, value: l.value };
      return acc;
    }, {});

    // Invoice stats
    const invoiceStats = invoices.reduce((acc, i) => {
      acc[i._id] = { count: i.count, total: i.total };
      return acc;
    }, {});

    const overdueInvoicesCount = await Invoice.countDocuments({
      companyId,
      status: { $in: ['sent', 'viewed', 'partial'] },
      dueAt: { $lt: now },
    });

    // AI quality metrics from chats
    const aiMetrics = await Chat.aggregate([
      { $match: { companyId } },
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'assistant' } },
      { $group: {
        _id: null,
        avgConfidence: { $avg: '$messages.confidence' },
        thumbsUp: { $sum: { $cond: [{ $eq: ['$messages.feedback', 'up'] }, 1, 0] } },
        thumbsDown: { $sum: { $cond: [{ $eq: ['$messages.feedback', 'down'] }, 1, 0] } },
        total: { $sum: 1 },
      }},
    ]);

    const payload = {
        overview: {
          documents: { total: totalDocs, thisMonth: docsThisMonth },
          conversations: { total: totalChats, thisMonth: chatsThisMonth },
          questionsAsked: company.usage.questionsAsked,
          agentExecutions: company.usage.agentExecutions,
        },
        leads: {
          pipeline: leadStats,
          newThisMonth: leadsThisMonth,
          totalValue: leads.reduce((s, l) => s + l.value, 0),
        },
        invoices: {
          byStatus: invoiceStats,
          overdue: overdueInvoicesCount,
          outstanding: invoices
            .filter(i => ['sent', 'viewed', 'partial', 'overdue'].includes(i._id))
            .reduce((s, i) => s + i.total, 0),
        },
        appointments: { upcoming: upcomingAppointments },
        products: {
          total: productAgg[0]?.total || 0,
          active: productAgg[0]?.active || 0,
          outOfStock: productAgg[0]?.outOfStock || 0,
          lowStock: productAgg[0]?.lowStock || 0,
        },
        ai: {
          avgConfidence: aiMetrics[0]?.avgConfidence ? Math.round(aiMetrics[0].avgConfidence) : 0,
          thumbsUp: aiMetrics[0]?.thumbsUp || 0,
          thumbsDown: aiMetrics[0]?.thumbsDown || 0,
          satisfactionRate: aiMetrics[0]
            ? Math.round((aiMetrics[0].thumbsUp / (aiMetrics[0].thumbsUp + aiMetrics[0].thumbsDown + 1)) * 100)
            : null,
        },
        subscription: {
          plan: company.subscription.plan,
          status: company.subscription.status,
          usage: company.usage,
          limits: company.limits,
        },
        recentActivity: recentActivity.map(log => ({
          action: log.action,
          description: log.description,
          user: log.userId,
          timestamp: log.timestamp,
          status: log.status,
        })),
    };

    cache.set(cacheKey, payload, 300); // 5 minutes
    res.status(200).json({ success: true, data: payload });
  } catch (err) { next(err); }
};

exports.getAIInsights = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const [leadCount, overdueInvoices, staleLeads] = await Promise.all([
      Lead.countDocuments({ companyId, status: { $in: ['new', 'contacted'] } }),
      Invoice.countDocuments({ companyId, status: { $in: ['sent', 'viewed'] }, dueAt: { $lt: new Date() } }),
      Lead.countDocuments({
        companyId,
        lastContactedAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        status: { $in: ['contacted', 'qualified'] },
      }),
    ]);

    const recommendations = [];
    if (overdueInvoices > 0) recommendations.push({ type: 'warning', message: `${overdueInvoices} invoice${overdueInvoices > 1 ? 's' : ''} are overdue and need attention.`, action: '/invoices?status=overdue', priority: 'high' });
    if (staleLeads > 0) recommendations.push({ type: 'info', message: `${staleLeads} lead${staleLeads > 1 ? 's' : ''} haven't been contacted in 7+ days.`, action: '/leads', priority: 'medium' });
    if (leadCount > 0) recommendations.push({ type: 'success', message: `${leadCount} new lead${leadCount > 1 ? 's' : ''} in your pipeline ready for follow-up.`, action: '/leads?status=new', priority: 'medium' });

    res.status(200).json({ success: true, data: { recommendations } });
  } catch (err) { next(err); }
};

// ── GET /analytics/usage — current usage vs plan limits ─────────────────
exports.getUsage = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const company = await Company.findById(companyId).select('subscription limits').lean();
    if (!company) return next(new AppError('Company not found.', 404));

    const sub = company.subscription || {};
    const limits = company.limits || {};
    const plan = sub.plan || 'trial';

    const now = new Date();
    const periodStart = sub.currentPeriodStart
      ? new Date(sub.currentPeriodStart)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd)
      : new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [aiAgg, docsUsed, teamUsed] = await Promise.all([
      Chat.aggregate([
        { $match: { companyId, lastMessageAt: { $gte: periodStart } } },
        { $unwind: '$messages' },
        { $match: { 'messages.role': 'user', 'messages.createdAt': { $gte: periodStart } } },
        { $count: 'n' },
      ]),
      Document.countDocuments({ companyId, status: { $ne: 'failed' } }),
      User.countDocuments({ companyId, status: 'active' }),
    ]);

    const meter = (used, limit) => {
      const lim = Number(limit) || 0;
      return { used, limit: lim, percent: lim > 0 ? Math.min(100, Math.round((used / lim) * 100)) : 0 };
    };

    res.status(200).json({
      success: true,
      data: {
        aiQuestions: meter(aiAgg[0]?.n || 0, limits.maxQuestionsPerMonth),
        documents: meter(docsUsed, limits.maxDocuments),
        teamMembers: meter(teamUsed, limits.maxUsers),
        plan,
        periodStart,
        periodEnd,
        daysRemaining: Math.max(0, Math.ceil((periodEnd - now) / 86400000)),
      },
    });
  } catch (err) { next(err); }
};
