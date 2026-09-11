'use strict';

const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Chat = require('../models/Chat');
const Document = require('../models/Document');
const { generateStructured, runAgent } = require('../services/groqService');
const { cleanAIText } = require('../utils/cleanAIText');
const { AppError } = require('../middleware/errorMiddleware');

async function gatherReportData(companyId, type, period) {
  const now = new Date();
  const periodMap = { week: 7, month: 30, quarter: 90, year: 365 };
  const days = periodMap[period] || 30;
  const from = new Date(now - days * 24 * 60 * 60 * 1000);

  const data = { period, from: from.toDateString(), to: now.toDateString(), companyId };

  if (type === 'sales' || type === 'full') {
    const [leads, invoices] = await Promise.all([
      Lead.aggregate([
        { $match: { companyId, createdAt: { $gte: from } } },
        { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$value' } } },
      ]),
      Invoice.aggregate([
        { $match: { companyId, createdAt: { $gte: from } } },
        { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
      ]),
    ]);
    data.leads = leads;
    data.invoices = invoices;
  }

  if (type === 'ai' || type === 'full') {
    const aiMetrics = await Chat.aggregate([
      { $match: { companyId, createdAt: { $gte: from } } },
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'assistant' } },
      { $group: { _id: null, total: { $sum: 1 }, avgConfidence: { $avg: '$messages.confidence' }, thumbsUp: { $sum: { $cond: [{ $eq: ['$messages.feedback', 'up'] }, 1, 0] } }, thumbsDown: { $sum: { $cond: [{ $eq: ['$messages.feedback', 'down'] }, 1, 0] } } } },
    ]);
    data.aiMetrics = aiMetrics[0] || {};
  }

  return data;
}

exports.generateReport = async (req, res, next) => {
  try {
    const { type = 'sales', period = 'month', customPrompt } = req.body;

    const validTypes = ['sales', 'finance', 'ai', 'operations', 'full'];
    if (!validTypes.includes(type)) return next(new AppError(`Invalid report type. Use: ${validTypes.join(', ')}`, 400));

    const rawData = await gatherReportData(req.companyId, type, period);

    const prompt = customPrompt || `Generate a comprehensive ${type} report for the ${period} period.

Data:
${JSON.stringify(rawData, null, 2)}

Include: executive summary, key metrics, trends, problems identified, and actionable recommendations.`;

    const schema = {
      title: 'string',
      executiveSummary: 'string',
      keyMetrics: 'array of {label: string, value: string, trend: up|down|stable, change: string}',
      insights: 'array of strings',
      problems: 'array of strings',
      recommendations: 'array of {action: string, priority: high|medium|low, impact: string}',
      conclusion: 'string',
    };

    const report = await generateStructured(prompt, schema, 'report_agent');
    report.executiveSummary = cleanAIText(report.executiveSummary);
    report.conclusion = cleanAIText(report.conclusion);

    res.status(200).json({
      success: true,
      data: {
        ...report,
        type,
        period,
        generatedAt: new Date(),
        rawData,
      },
    });
  } catch (err) { next(err); }
};

exports.getReportTypes = async (req, res, next) => {
  res.status(200).json({
    success: true,
    data: [
      { id: 'sales', name: 'Sales Report', description: 'Lead pipeline, conversion rates, revenue' },
      { id: 'finance', name: 'Finance Report', description: 'Invoice status, payments, outstanding balance' },
      { id: 'ai', name: 'AI Usage Report', description: 'Questions asked, confidence scores, agent usage' },
      { id: 'operations', name: 'Operations Report', description: 'Orders, appointments, team activity' },
      { id: 'full', name: 'Full Business Report', description: 'Comprehensive overview of all metrics' },
    ],
  });
};
