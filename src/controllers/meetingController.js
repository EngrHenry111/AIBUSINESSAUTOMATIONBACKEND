'use strict';

const Meeting = require('../models/Meeting');
const { generateStructured } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

exports.getMeetings = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;
    const [meetings, total] = await Promise.all([
      Meeting.find(filter)
        .populate('participants', 'name avatar')
        .populate('createdBy', 'name')
        .sort({ scheduledAt: -1 }).skip(skip).limit(Number(limit)),
      Meeting.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, data: meetings, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

exports.createMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.create({ ...req.body, companyId: req.companyId, createdBy: req.user._id });
    res.status(201).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.getMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('participants', 'name avatar email');
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.updateMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      req.body, { new: true, runValidators: true }
    );
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.summarizeMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));

    const content = req.body.transcript || meeting.transcript;
    if (!content) return next(new AppError('No transcript provided. Upload a transcript first.', 400));

    const prompt = `Analyze this meeting transcript and extract structured information:

Meeting Title: ${meeting.title}
Date: ${meeting.scheduledAt ? new Date(meeting.scheduledAt).toDateString() : 'Unknown'}

TRANSCRIPT:
${content.substring(0, 8000)}

Extract a comprehensive meeting analysis.`;

    const schema = {
      summary: 'string - 3-5 sentence executive summary',
      keyDecisions: 'array of strings',
      actionItems: 'array of {task: string, assignedTo: string, dueDate: string, priority: high|medium|low}',
      risks: 'array of strings',
      followUps: 'array of strings',
      sentiment: 'string - overall meeting tone',
    };

    const analysis = await generateStructured(prompt, schema, 'meeting_agent');

    meeting.transcript = content;
    meeting.status = 'completed';
    meeting.ai = {
      summary: analysis.summary,
      keyDecisions: analysis.keyDecisions || [],
      actionItems: analysis.actionItems || [],
      risks: analysis.risks || [],
      followUps: analysis.followUps || [],
      sentiment: analysis.sentiment,
      processedAt: new Date(),
    };
    await meeting.save();

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'meeting.summarize', resource: 'Meeting', resourceId: meeting._id, ip: req.ip });

    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.deleteMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    res.status(200).json({ success: true, message: 'Meeting deleted.' });
  } catch (err) { next(err); }
};
