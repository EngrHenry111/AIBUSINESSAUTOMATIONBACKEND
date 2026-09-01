'use strict';
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceTenant } = require('../middleware/tenantMiddleware');
const { aiLimiter } = require('../middleware/rateLimitMiddleware');
const { runAgent, generateStructured } = require('../services/groqService');
const Company = require('../models/Company');
const router = express.Router();

router.use(protect, enforceTenant);

const AGENTS = [
  { id: 'knowledge_assistant', name: 'Knowledge Assistant', description: 'Answers questions from your company knowledge base', category: 'knowledge' },
  { id: 'lead_agent', name: 'Lead Follow-Up Agent', description: 'Scores, qualifies, and drafts follow-ups for leads', category: 'sales' },
  { id: 'meeting_agent', name: 'Meeting Summary Agent', description: 'Summarizes meetings and extracts action items', category: 'productivity' },
  { id: 'invoice_agent', name: 'Invoice Reminder Agent', description: 'Tracks overdue invoices and drafts reminders', category: 'finance' },
  { id: 'support_agent', name: 'Customer Support Agent', description: 'Classifies tickets and drafts support responses', category: 'support' },
  { id: 'social_agent', name: 'Social Media Agent', description: 'Plans and drafts social media content', category: 'marketing' },
  { id: 'report_agent', name: 'Report Agent', description: 'Generates business reports and analytics summaries', category: 'analytics' },
  { id: 'hr_agent', name: 'HR Assistant Agent', description: 'Assists with HR policies, job descriptions, and communications', category: 'hr' },
  { id: 'analytics_agent', name: 'Analytics Agent', description: 'Interprets data and provides business insights', category: 'analytics' },
];

router.get('/', (req, res) => {
  res.status(200).json({ success: true, data: AGENTS });
});

router.post('/run', aiLimiter, async (req, res, next) => {
  try {
    const { agentId, input, options = {} } = req.body;
    if (!agentId || !input) return res.status(400).json({ success: false, message: 'agentId and input are required' });
    if (!AGENTS.find(a => a.id === agentId)) return res.status(400).json({ success: false, message: 'Unknown agent' });

    await Company.findByIdAndUpdate(req.companyId, { $inc: { 'usage.agentExecutions': 1 } });
    const result = await runAgent(agentId, input, options);
    res.status(200).json({ success: true, agentId, result, executedAt: new Date() });
  } catch (err) { next(err); }
});

module.exports = router;
