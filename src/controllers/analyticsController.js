'use strict';

const Company = require('../models/Company');
const Document = require('../models/Document');
const Chat = require('../models/Chat');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Appointment = require('../models/Appointment');
const AuditLog = require('../models/AuditLog');
const { generateStructured } = require('../services/groqService');

exports.getDashboardMetrics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
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

    res.status(200).json({
      success: true,
      data: {
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
      },
    });
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
