'use strict';

const fs = require('fs');
const Meeting = require('../models/Meeting');
const User = require('../models/User');
const Company = require('../models/Company');
const { generateStructured, runAgent } = require('../services/groqService');
const { cleanAIText, cleanAIObject } = require('../utils/cleanAIText');
const { cloudinary } = require('../config/cloudinary');
const emailService = require('../services/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Reference number: MTG/2026/001, per company per year ──────────────
async function generateReferenceNumber(companyId) {
  const year = new Date().getFullYear();
  const count = await Meeting.countDocuments({
    companyId,
    referenceNumber: { $regex: `^MTG/${year}/` },
  });
  return `MTG/${year}/${String(count + 1).padStart(3, '0')}`;
}

// ── Attendee list for emails: registered participants + external guests ─
async function resolveAttendees(meeting) {
  const users = meeting.participants?.length
    ? await User.find({ _id: { $in: meeting.participants } }).select('name email')
    : [];
  const external = (meeting.externalParticipants || []).filter((p) => p.email);
  return [
    ...users.map((u) => ({ id: u._id, name: u.name, email: u.email })),
    ...external.map((p) => ({ id: null, name: p.name, email: p.email })),
  ];
}

function notifyCompany(req, companyId, payload) {
  const io = req.app.get('io');
  if (io) io.to(`company:${companyId}`).emit('notification:refresh', payload);
}

// ── Recurring: compute the next occurrence's date ──────────────────────
function nextOccurrenceDate(date, interval) {
  const d = new Date(date);
  switch (interval) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annually': d.setFullYear(d.getFullYear() + 1); break;
    default: return null;
  }
  return d;
}

// ── GET /meetings ───────────────────────────────────────────────────────
exports.getMeetings = async (req, res, next) => {
  try {
    const { status, meetingType, page = 1, limit = 20, from, to } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (meetingType) filter.meetingType = meetingType;
    if (from || to) {
      filter.scheduledAt = {};
      if (from) filter.scheduledAt.$gte = new Date(from);
      if (to) filter.scheduledAt.$lte = new Date(to);
    }

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

// ── POST /meetings ───────────────────────────────────────────────────────
exports.createMeeting = async (req, res, next) => {
  try {
    const body = { ...req.body };
    const referenceNumber = await generateReferenceNumber(req.companyId);

    // Seed the attendance list from participants/external guests so the
    // organizer doesn't have to retype names.
    let attendance = body.attendance;
    if (!attendance) {
      const users = body.participants?.length
        ? await User.find({ _id: { $in: body.participants } }).select('name email')
        : [];
      attendance = [
        ...users.map((u) => ({ name: u.name, email: u.email, role: 'Team member', status: 'absent' })),
        ...(body.externalParticipants || []).map((p) => ({ name: p.name, email: p.email, role: 'Guest', status: 'absent' })),
      ];
    }

    const meeting = await Meeting.create({
      ...body,
      attendance,
      referenceNumber,
      companyId: req.companyId,
      createdBy: req.user._id,
    });

    // Email every attendee + surface an in-app notification for participants.
    const attendees = await resolveAttendees(meeting);
    if (attendees.length) {
      Promise.all(attendees.map((a) =>
        emailService.sendMeetingInvite(a.email, a.name, meeting, req.user.name)
          .catch((e) => logger.warn(`Meeting invite to ${a.email} failed: ${e.message}`))
      )).catch(() => {});
    }
    notifyCompany(req, req.companyId, { type: 'meeting_scheduled', meetingId: meeting._id });
    cache.del(`dashboard_${req.companyId}`);

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'meeting.create', resource: 'Meeting', resourceId: meeting._id, description: meeting.title, ip: req.ip });

    res.status(201).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ── GET /meetings/:id ─────────────────────────────────────────────────
exports.getMeeting = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('participants', 'name avatar email')
      .populate('createdBy', 'name')
      .populate('actionItems.assignedTo', 'name email')
      .populate('previousMeetingId', 'title referenceNumber scheduledAt minutes');
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ── PUT /meetings/:id ─────────────────────────────────────────────────
exports.updateMeeting = async (req, res, next) => {
  try {
    const existing = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!existing) return next(new AppError('Meeting not found.', 404));

    const wasCompleted = existing.status === 'completed';
    Object.assign(existing, req.body);
    await existing.save();

    // Recurring: auto-create the next occurrence the moment this one is
    // marked completed (once only, guarded by nextOccurrenceCreated).
    if (!wasCompleted && existing.status === 'completed' && existing.isRecurring
      && existing.recurringInterval && !existing.nextOccurrenceCreated && existing.scheduledAt) {
      const nextDate = nextOccurrenceDate(existing.scheduledAt, existing.recurringInterval);
      if (nextDate) {
        const nextRef = await generateReferenceNumber(req.companyId);
        const next = await Meeting.create({
          companyId: req.companyId,
          title: existing.title,
          description: existing.description,
          meetingType: existing.meetingType,
          location: existing.location,
          chairman: existing.chairman,
          secretary: existing.secretary,
          duration: existing.duration,
          participants: existing.participants,
          externalParticipants: existing.externalParticipants,
          agenda: (existing.agenda || []).map((a) => ({ ...a.toObject(), completed: false })),
          quorumRequired: existing.quorumRequired,
          isRecurring: true,
          recurringInterval: existing.recurringInterval,
          referenceNumber: nextRef,
          scheduledAt: nextDate,
          previousMeetingId: existing._id,
          createdBy: req.user._id,
        });
        existing.nextOccurrenceCreated = true;
        await existing.save();
        logger.info(`🔁 Auto-created next occurrence of "${existing.title}" → ${next.referenceNumber} on ${nextDate.toDateString()}`);
      }
    }

    cache.del(`dashboard_${req.companyId}`);
    res.status(200).json({ success: true, data: existing });
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
      summary: cleanAIText(analysis.summary),
      keyDecisions: cleanAIObject(analysis.keyDecisions || []),
      actionItems: cleanAIObject(analysis.actionItems || []),
      risks: cleanAIObject(analysis.risks || []),
      followUps: cleanAIObject(analysis.followUps || []),
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

// ═══════════════════════════ Agenda builder ═══════════════════════════
exports.addAgendaItem = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    if (!req.body.title) return next(new AppError('Agenda item title is required.', 400));

    meeting.agenda.push({
      number: req.body.number ?? meeting.agenda.length + 1,
      title: req.body.title,
      presenter: req.body.presenter,
      timeAllocated: req.body.timeAllocated,
      notes: req.body.notes,
    });
    await meeting.save();
    res.status(201).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.updateAgendaItem = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    const item = meeting.agenda.id(req.params.itemId);
    if (!item) return next(new AppError('Agenda item not found.', 404));
    Object.assign(item, req.body);
    await meeting.save();
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.deleteAgendaItem = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    meeting.agenda.pull({ _id: req.params.itemId });
    await meeting.save();
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Attendance ═══════════════════════════════
exports.recordAttendance = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));

    const { attendance } = req.body; // full replacement array, or…
    if (Array.isArray(attendance)) {
      meeting.attendance = attendance;
    } else if (req.body.index != null && req.body.status) {
      // …a single row update by index
      const row = meeting.attendance[req.body.index];
      if (!row) return next(new AppError('Attendee not found.', 404));
      row.status = req.body.status;
    } else {
      return next(new AppError('Provide either an attendance array or { index, status }.', 400));
    }

    const invited = meeting.attendance.length;
    const present = meeting.attendance.filter((a) => a.status === 'present').length;
    meeting.quorumReached = invited > 0 && (present / invited) * 100 >= (meeting.quorumRequired || 50);

    await meeting.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'meeting.attendance_update', resource: 'Meeting', resourceId: meeting._id, ip: req.ip });
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Resolutions / motions ═════════════════════
exports.addResolution = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    if (!req.body.description) return next(new AppError('Resolution description is required.', 400));

    const year = meeting.scheduledAt ? new Date(meeting.scheduledAt).getFullYear() : new Date().getFullYear();
    const seq = meeting.resolutions.length + 1;

    meeting.resolutions.push({
      number: req.body.number || `${String(seq).padStart(3, '0')}/${year}`,
      description: req.body.description,
      proposedBy: req.body.proposedBy,
      secondedBy: req.body.secondedBy,
      votesFor: Number(req.body.votesFor) || 0,
      votesAgainst: Number(req.body.votesAgainst) || 0,
      votesAbstain: Number(req.body.votesAbstain) || 0,
    });
    const added = meeting.resolutions[meeting.resolutions.length - 1];
    added.status = added.votesFor > added.votesAgainst ? 'carried' : (added.votesFor + added.votesAgainst + added.votesAbstain > 0 ? 'rejected' : 'pending');

    await meeting.save();
    res.status(201).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// Record/adjust votes on a resolution (motion) and auto-declare the result.
exports.updateResolution = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    const resolution = meeting.resolutions.id(req.params.resolutionId);
    if (!resolution) return next(new AppError('Resolution not found.', 404));

    const { description, proposedBy, secondedBy, votesFor, votesAgainst, votesAbstain } = req.body;
    if (description !== undefined) resolution.description = description;
    if (proposedBy !== undefined) resolution.proposedBy = proposedBy;
    if (secondedBy !== undefined) resolution.secondedBy = secondedBy;
    if (votesFor !== undefined) resolution.votesFor = Number(votesFor) || 0;
    if (votesAgainst !== undefined) resolution.votesAgainst = Number(votesAgainst) || 0;
    if (votesAbstain !== undefined) resolution.votesAbstain = Number(votesAbstain) || 0;

    const totalVotes = resolution.votesFor + resolution.votesAgainst + resolution.votesAbstain;
    resolution.status = totalVotes === 0 ? 'pending' : (resolution.votesFor > resolution.votesAgainst ? 'carried' : 'rejected');

    await meeting.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'meeting.resolution_vote', resource: 'Meeting', resourceId: meeting._id, description: `${resolution.number}: ${resolution.status}`, ip: req.ip });
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.deleteResolution = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    meeting.resolutions.pull({ _id: req.params.resolutionId });
    await meeting.save();
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Action items ══════════════════════════════
exports.addActionItem = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    if (!req.body.task) return next(new AppError('Task description is required.', 400));

    meeting.actionItems.push({
      task: req.body.task,
      assignedTo: req.body.assignedTo || undefined,
      assignedToName: req.body.assignedToName,
      dueDate: req.body.dueDate || undefined,
    });
    await meeting.save();

    if (req.body.assignedTo) {
      notifyCompany(req, req.companyId, { type: 'action_item_assigned', meetingId: meeting._id, userId: req.body.assignedTo });
    }

    res.status(201).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.updateActionItem = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    const item = meeting.actionItems.id(req.params.itemId);
    if (!item) return next(new AppError('Action item not found.', 404));

    const { task, assignedTo, assignedToName, dueDate, status } = req.body;
    if (task !== undefined) item.task = task;
    if (assignedTo !== undefined) item.assignedTo = assignedTo || undefined;
    if (assignedToName !== undefined) item.assignedToName = assignedToName;
    if (dueDate !== undefined) item.dueDate = dueDate;
    if (status !== undefined) {
      item.status = status;
      item.completedAt = status === 'completed' ? new Date() : undefined;
    }

    await meeting.save();
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.deleteActionItem = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    meeting.actionItems.pull({ _id: req.params.itemId });
    await meeting.save();
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Minutes ═══════════════════════════════════
exports.saveMinutes = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));

    meeting.minutes = req.body.minutes ?? meeting.minutes;
    if (req.body.status && ['draft', 'final'].includes(req.body.status)) meeting.minutesStatus = req.body.status;

    await meeting.save();
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'meeting.minutes_save', resource: 'Meeting', resourceId: meeting._id, description: meeting.minutesStatus, ip: req.ip });
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.generateMinutesFromNotes = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));

    const notes = req.body.notes || meeting.minutes;
    if (!notes?.trim()) return next(new AppError('Add some rough notes first.', 400));

    const attendanceLines = (meeting.attendance || [])
      .map((a) => `${a.name || 'Unknown'} — ${a.status}`).join('\n') || 'Not recorded';
    const resolutionLines = (meeting.resolutions || [])
      .map((r) => `${r.number}: ${r.description} (${r.status})`).join('\n') || 'None';

    const prompt = `Turn the rough notes below into professional, formal meeting minutes for a ${meeting.meetingType || 'business'} meeting titled "${meeting.title}" (reference ${meeting.referenceNumber || 'N/A'}).

Date: ${meeting.scheduledAt ? new Date(meeting.scheduledAt).toDateString() : 'Unknown'}
Attendance:
${attendanceLines}

Resolutions recorded:
${resolutionLines}

ROUGH NOTES:
${notes.substring(0, 6000)}

Write it as complete, well-structured minutes: opening/call to order, attendance, matters arising, discussion points, resolutions, action items, and closing. Use clear paragraph and section labels, not markdown symbols.`;

    const formatted = cleanAIText(await runAgent('meeting_agent', prompt, { maxTokens: 1800 }));

    meeting.minutes = formatted;
    meeting.minutesStatus = 'draft';
    await meeting.save();

    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Previous minutes confirmation ═════════════
exports.confirmPreviousMinutes = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));

    meeting.previousMinutesConfirmed = true;
    meeting.previousMinutesConfirmedBy = req.body.confirmedBy || req.user.name;
    meeting.previousMinutesConfirmedAt = new Date();
    await meeting.save();

    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Attachments ═══════════════════════════════
exports.uploadAttachment = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    if (!req.file) return next(new AppError('No file received.', 400));

    let url;
    if (cloudinary) {
      const r = await cloudinary.uploader.upload(req.file.path, {
        folder: `business-ai/${req.companyId}/meetings/${meeting._id}`,
        resource_type: 'auto',
        use_filename: true,
      });
      fs.unlink(req.file.path, () => {});
      url = r.secure_url;
    } else {
      url = `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${req.file.path.split(/[\\/]/).pop()}`;
    }

    meeting.attachments.push({
      name: req.body.name || req.file.originalname,
      url,
      category: ['agenda', 'presentation', 'document'].includes(req.body.category) ? req.body.category : 'document',
      uploadedBy: req.user._id,
    });
    await meeting.save();

    res.status(201).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

exports.deleteAttachment = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!meeting) return next(new AppError('Meeting not found.', 404));
    meeting.attachments.pull({ _id: req.params.attachmentId });
    await meeting.save();
    res.status(200).json({ success: true, data: meeting });
  } catch (err) { next(err); }
};

// ═══════════════════════════ Official PDF export ═══════════════════════
exports.exportPDF = async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('actionItems.assignedTo', 'name');
    if (!meeting) return next(new AppError('Meeting not found.', 404));

    const company = await Company.findById(req.companyId).select('companyName logo website profile');
    const profile = company?.profile || {};
    const dt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;

    const attendanceRows = (meeting.attendance || []).map((a) => `
      <tr><td>${esc(a.name)}</td><td>${esc(a.role || '')}</td><td style="text-transform:capitalize">${esc(a.status)}</td></tr>
    `).join('') || '<tr><td colspan="3" style="color:#94a3b8;">No attendance recorded</td></tr>';

    const agendaRows = (meeting.agenda || []).sort((a, b) => (a.number || 0) - (b.number || 0)).map((a) => `
      <tr><td>${a.number ?? ''}</td><td>${esc(a.title)}</td><td>${esc(a.presenter || '')}</td><td>${a.timeAllocated ? `${a.timeAllocated} min` : ''}</td></tr>
    `).join('') || '<tr><td colspan="4" style="color:#94a3b8;">No agenda items</td></tr>';

    const resolutionBlocks = (meeting.resolutions || []).map((r) => `
      <div class="resolution">
        <p><strong>RESOLUTION ${esc(r.number)}:</strong> ${esc(r.description)}</p>
        <p class="res-meta">Proposed by: ${esc(r.proposedBy || '—')} · Seconded by: ${esc(r.secondedBy || '—')}</p>
        <p class="res-meta">Votes — For: ${r.votesFor} · Against: ${r.votesAgainst} · Abstain: ${r.votesAbstain}</p>
        <p class="res-status ${r.status}">${r.status.toUpperCase()}</p>
      </div>
    `).join('') || '<p style="color:#94a3b8;">No resolutions recorded.</p>';

    const actionRows = (meeting.actionItems || []).map((a) => `
      <tr>
        <td>${esc(a.task)}</td>
        <td>${esc(a.assignedTo?.name || a.assignedToName || '—')}</td>
        <td>${a.dueDate ? new Date(a.dueDate).toLocaleDateString() : '—'}</td>
        <td style="text-transform:capitalize">${esc(a.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="color:#94a3b8;">No action items</td></tr>';

    const present = (meeting.attendance || []).filter((a) => a.status === 'present').length;
    const total = (meeting.attendance || []).length;
    const attendancePct = total ? Math.round((present / total) * 100) : 0;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color:#1e293b; padding: 48px; line-height: 1.6; }
  .letterhead { display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 3px double #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
  .lh-left { display:flex; gap: 14px; align-items:center; }
  .lh-logo { width: 56px; height: 56px; object-fit: contain; border-radius: 8px; }
  .lh-name { font-size: 20px; font-weight: 700; }
  .lh-sub { font-size: 11px; color:#475569; margin-top: 4px; line-height: 1.5; }
  .lh-right { text-align:right; font-size: 11px; color:#475569; }
  .title-block { text-align:center; margin: 20px 0 28px; }
  .title-block h1 { font-size: 20px; text-transform: uppercase; letter-spacing: 0.04em; }
  .title-block .ref { font-size: 12px; color:#475569; margin-top: 6px; }
  .meta-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; font-size: 13px; margin-bottom: 24px; }
  h2.section { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin: 26px 0 10px; }
  table { width:100%; border-collapse: collapse; font-size: 13px; margin-bottom: 10px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align:left; vertical-align: top; }
  th { background:#f1f5f9; font-size: 11px; text-transform: uppercase; }
  .quorum { font-weight:700; }
  .quorum.reached { color:#166534; }
  .quorum.not-reached { color:#991b1b; }
  .resolution { border:1px solid #cbd5e1; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; }
  .res-meta { font-size: 11px; color:#475569; margin-top: 4px; }
  .res-status { font-weight:700; font-size:12px; margin-top:6px; }
  .res-status.carried { color:#166534; }
  .res-status.rejected { color:#991b1b; }
  .res-status.pending { color:#92400e; }
  .minutes-body { white-space: pre-line; font-size: 13px; text-align: justify; }
  .signatures { display:flex; justify-content:space-between; margin-top: 56px; }
  .sig-block { width: 42%; text-align:center; }
  .sig-line { border-top: 1px solid #1e293b; margin-top: 44px; padding-top: 6px; font-size: 12px; }
  .seal { width: 42%; text-align:center; }
  .seal-box { border: 1px dashed #94a3b8; border-radius: 50%; width: 100px; height: 100px; margin: 0 auto 8px; display:flex; align-items:center; justify-content:center; font-size:10px; color:#94a3b8; }
  .footer { margin-top: 40px; text-align:center; font-size: 10px; color:#94a3b8; border-top: 1px solid #e2e8f0; padding-top: 12px; }
</style>
</head>
<body>

<div class="letterhead">
  <div class="lh-left">
    ${company?.logo ? `<img class="lh-logo" src="${company.logo}" alt=""/>` : ''}
    <div>
      <div class="lh-name">${esc(company?.companyName || 'BizlyAI')}</div>
      <div class="lh-sub">
        ${profile.address ? esc(profile.address) + '<br/>' : ''}
        ${[profile.phone, profile.email].filter(Boolean).map(esc).join(' · ')}
        ${(profile.rcNumber || profile.tin) ? `<br/>${profile.rcNumber ? `RC: ${esc(profile.rcNumber)}` : ''}${profile.rcNumber && profile.tin ? ' · ' : ''}${profile.tin ? `TIN: ${esc(profile.tin)}` : ''}` : ''}
      </div>
    </div>
  </div>
  <div class="lh-right">
    ${company?.website ? esc(company.website) + '<br/>' : ''}
    Generated ${new Date().toLocaleDateString()}
  </div>
</div>

<div class="title-block">
  <h1>Minutes of ${esc((meeting.meetingType || 'business').replace('_', ' '))} Meeting</h1>
  <div class="ref">${esc(meeting.title)} ${meeting.referenceNumber ? `— Ref: ${esc(meeting.referenceNumber)}` : ''}</div>
</div>

<div class="meta-grid">
  <div><strong>Date:</strong> ${dt ? dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD'}</div>
  <div><strong>Time:</strong> ${dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'TBD'}</div>
  <div><strong>Location:</strong> ${esc(meeting.location || 'N/A')}</div>
  <div><strong>Duration:</strong> ${meeting.duration ? `${meeting.duration} minutes` : 'N/A'}</div>
  <div><strong>Chairman:</strong> ${esc(meeting.chairman || 'N/A')}</div>
  <div><strong>Secretary:</strong> ${esc(meeting.secretary || 'N/A')}</div>
</div>

${meeting.previousMeetingId ? `
<h2 class="section">Confirmation of Previous Minutes</h2>
<p style="font-size:13px;">
  ${meeting.previousMinutesConfirmed
    ? `Minutes of the previous meeting were confirmed by ${esc(meeting.previousMinutesConfirmedBy || '—')} on ${meeting.previousMinutesConfirmedAt ? new Date(meeting.previousMinutesConfirmedAt).toLocaleDateString() : '—'}.`
    : 'Minutes of the previous meeting are yet to be confirmed.'}
</p>` : ''}

<h2 class="section">Agenda</h2>
<table>
  <thead><tr><th>#</th><th>Item</th><th>Presenter</th><th>Time</th></tr></thead>
  <tbody>${agendaRows}</tbody>
</table>

<h2 class="section">Attendance</h2>
<table>
  <thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
  <tbody>${attendanceRows}</tbody>
</table>
<p style="font-size:12px;">Attendance: ${present}/${total} (${attendancePct}%) — Quorum required: ${meeting.quorumRequired || 50}% —
  <span class="quorum ${meeting.quorumReached ? 'reached' : 'not-reached'}">${meeting.quorumReached ? 'QUORUM REACHED' : 'QUORUM NOT REACHED'}</span>
</p>

<h2 class="section">Minutes / Discussion</h2>
<div class="minutes-body">${esc(meeting.minutes || 'No minutes recorded yet.')}</div>

<h2 class="section">Resolutions</h2>
${resolutionBlocks}

<h2 class="section">Action Items</h2>
<table>
  <thead><tr><th>Task</th><th>Assigned To</th><th>Due Date</th><th>Status</th></tr></thead>
  <tbody>${actionRows}</tbody>
</table>

<div class="signatures">
  <div class="sig-block"><div class="sig-line">Chairman: ${esc(meeting.chairman || '')}</div></div>
  <div class="sig-block"><div class="sig-line">Secretary: ${esc(meeting.secretary || '')}</div></div>
</div>
<div style="display:flex; justify-content:center; margin-top: 24px;">
  <div class="seal"><div class="seal-box">OFFICIAL<br/>SEAL</div></div>
</div>

<div class="footer">
  ${esc(company?.companyName || 'BizlyAI')} · Official meeting minutes generated via BizlyAI · Reference ${esc(meeting.referenceNumber || 'N/A')}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="minutes-${meeting.referenceNumber || meeting._id}.html"`);
    res.send(html);
  } catch (err) { next(err); }
};
