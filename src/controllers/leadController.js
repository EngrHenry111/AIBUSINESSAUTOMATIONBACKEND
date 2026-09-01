'use strict';

const Lead = require('../models/Lead');
const { runAgent, generateStructured } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

exports.getLeads = async (req, res, next) => {
  try {
    const { status, assignedTo, source, page = 1, limit = 20, search } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (source) filter.source = source;
    if (search) filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { company: { $regex: search, $options: 'i' } },
    ];

    const skip = (page - 1) * limit;
    const [leads, total] = await Promise.all([
      Lead.find(filter)
        .populate('assignedTo', 'name avatar')
        .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Lead.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true, data: leads,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

exports.createLead = async (req, res, next) => {
  try {
    const lead = await Lead.create({ ...req.body, companyId: req.companyId, createdBy: req.user._id });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'lead.create', resource: 'Lead', resourceId: lead._id, ip: req.ip });
    res.status(201).json({ success: true, data: lead });
  } catch (err) { next(err); }
};

exports.getLead = async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('assignedTo', 'name avatar email')
      .populate('createdBy', 'name');
    if (!lead) return next(new AppError('Lead not found.', 404));
    res.status(200).json({ success: true, data: lead });
  } catch (err) { next(err); }
};

exports.updateLead = async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { ...req.body },
      { new: true, runValidators: true }
    );
    if (!lead) return next(new AppError('Lead not found.', 404));
    res.status(200).json({ success: true, data: lead });
  } catch (err) { next(err); }
};

exports.deleteLead = async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!lead) return next(new AppError('Lead not found.', 404));
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'lead.delete', resource: 'Lead', resourceId: req.params.id, ip: req.ip });
    res.status(200).json({ success: true, message: 'Lead deleted.' });
  } catch (err) { next(err); }
};

exports.analyzeLead = async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!lead) return next(new AppError('Lead not found.', 404));

    const prompt = `Analyze this sales lead and provide a JSON response:

Lead Data:
- Name: ${lead.name}
- Email: ${lead.email}
- Company: ${lead.company || 'Unknown'}
- Position: ${lead.position || 'Unknown'}
- Source: ${lead.source}
- Status: ${lead.status}
- Value: ${lead.value} ${lead.currency}
- Last contacted: ${lead.lastContactedAt ? new Date(lead.lastContactedAt).toDateString() : 'Never'}
- Notes: ${lead.notes || 'None'}

Provide analysis with lead quality score (0-100), recommended next action, urgency, and a professional follow-up email draft.`;

    const schema = {
      score: 'number 0-100',
      priority: 'high|medium|low',
      sentiment: 'positive|neutral|negative',
      summary: 'string',
      recommendedAction: 'string',
      followUpDraft: 'string (full email)',
    };

    const analysis = await generateStructured(prompt, schema, 'lead_agent');

    lead.score = analysis.score || lead.score;
    lead.ai = {
      summary: analysis.summary,
      recommendedAction: analysis.recommendedAction,
      followUpDraft: analysis.followUpDraft,
      sentiment: analysis.sentiment,
      priority: analysis.priority,
      analyzedAt: new Date(),
    };
    await lead.save();

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'lead.ai_analyze', resource: 'Lead', resourceId: lead._id, ip: req.ip });

    res.status(200).json({ success: true, data: lead });
  } catch (err) { next(err); }
};

exports.bulkAnalyzeLeads = async (req, res, next) => {
  try {
    const { status = 'new' } = req.query;
    const leads = await Lead.find({ companyId: req.companyId, status }).limit(10);
    res.status(202).json({ success: true, message: `Analyzing ${leads.length} leads. Check back shortly.`, count: leads.length });

    // Process async
    for (const lead of leads) {
      try {
        await exports.analyzeLead({ params: { id: lead._id }, companyId: req.companyId, user: req.user, ip: req.ip }, { status: () => ({ json: () => {} }) }, () => {});
      } catch { /* continue */ }
    }
  } catch (err) { next(err); }
};
