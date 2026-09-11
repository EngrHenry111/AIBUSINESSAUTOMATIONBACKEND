'use strict';

const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const Meeting = require('../models/Meeting');
const { generateStructured } = require('../services/groqService');
const { cleanAIText } = require('../utils/cleanAIText');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `notes` is now a thread; never let a plain string from an older client land
// in that array — route it to `description` instead.
function normalizeNoteField(body) {
  if (typeof body.notes === 'string') {
    if (body.notes.trim() && body.description == null) body.description = body.notes;
    delete body.notes;
  }
  return body;
}

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
    normalizeNoteField(req.body);
    const lead = await Lead.create({ ...req.body, companyId: req.companyId, createdBy: req.user._id });
    require('../utils/cache').del(`dashboard_${req.companyId}`);
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
    normalizeNoteField(req.body);
    const prev = await Lead.findOne({ _id: req.params.id, companyId: req.companyId }).select('status');
    if (!prev) return next(new AppError('Lead not found.', 404));

    const update = { ...req.body };
    // Log a status change onto the activity trail
    if (update.status && update.status !== prev.status) {
      update.$push = {
        activities: {
          type: 'status_change',
          description: `Status changed from ${prev.status} to ${update.status}`,
          performedBy: req.user._id,
          performedAt: new Date(),
        },
      };
    }

    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      update,
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
- Notes: ${[lead.description, ...(lead.notes || []).map((n) => n.content)].filter(Boolean).join(' | ') || 'None'}

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
      summary: cleanAIText(analysis.summary),
      recommendedAction: cleanAIText(analysis.recommendedAction),
      followUpDraft: cleanAIText(analysis.followUpDraft),
      sentiment: analysis.sentiment,
      priority: analysis.priority,
      analyzedAt: new Date(),
    };
    await lead.save();

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'lead.ai_analyze', resource: 'Lead', resourceId: lead._id, ip: req.ip });

    res.status(200).json({ success: true, data: lead });
  } catch (err) { next(err); }
};

// ── GET /leads/:id — full detail + related records + activity timeline ────
exports.getLeadDetail = async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('assignedTo', 'name avatar email')
      .populate('createdBy', 'name')
      .populate('notes.createdBy', 'name')
      .populate('activities.performedBy', 'name')
      .lean();
    if (!lead) return next(new AppError('Lead not found.', 404));

    const email = lead.email;
    const nameRx = { $regex: escapeRegex(lead.name), $options: 'i' };

    const [invoices, appointments, meetings] = await Promise.all([
      email
        ? Invoice.find({ companyId: req.companyId, 'customer.email': email }).sort({ createdAt: -1 }).lean()
        : [],
      email
        ? Appointment.find({ companyId: req.companyId, 'customer.email': email }).sort({ scheduledAt: -1 }).lean()
        : [],
      Meeting.find({
        companyId: req.companyId,
        $or: [
          ...(email ? [{ 'externalParticipants.email': email }] : []),
          { title: nameRx },
          ...(lead.company ? [{ title: { $regex: escapeRegex(lead.company), $options: 'i' } }] : []),
        ],
      }).sort({ scheduledAt: -1 }).limit(25).lean(),
    ]);

    const timeline = [
      {
        type: 'created', icon: 'created',
        description: 'Lead created',
        at: lead.createdAt, user: lead.createdBy?.name || null,
      },
      ...(lead.activities || []).map((a) => ({
        type: a.type || 'activity', icon: a.type || 'activity',
        description: a.description, at: a.performedAt, user: a.performedBy?.name || null,
      })),
      ...(lead.notes || []).map((n) => ({
        type: 'note', icon: 'note',
        description: `Note added: "${(n.content || '').slice(0, 100)}${(n.content || '').length > 100 ? '…' : ''}"`,
        at: n.createdAt, user: n.createdBy?.name || null,
      })),
      ...invoices.map((i) => ({
        type: 'invoice', icon: 'invoice',
        description: `Invoice ${i.invoiceNumber} · ${i.currency || 'USD'} ${Number(i.total || 0).toLocaleString()} (${i.status})`,
        at: i.createdAt, user: null, link: '/invoices',
      })),
      ...appointments.map((a) => ({
        type: 'appointment', icon: 'appointment',
        description: `Appointment scheduled: ${a.title}`,
        at: a.scheduledAt || a.createdAt, user: null, link: '/appointments',
      })),
      ...meetings.map((m) => ({
        type: 'meeting', icon: 'meeting',
        description: `Meeting: ${m.title}`,
        at: m.scheduledAt || m.createdAt, user: null, link: '/meetings',
      })),
    ]
      .filter((e) => e.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at));

    res.status(200).json({
      success: true,
      data: {
        lead,
        invoices,
        appointments,
        meetings,
        notes: lead.notes || [],
        activityTimeline: timeline,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /leads/:id/notes ───────────────────────────────────────────────
exports.addNote = async (req, res, next) => {
  try {
    const content = (req.body.content || '').trim();
    if (!content) return next(new AppError('Note content is required.', 400));

    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      {
        $push: {
          notes: { content, createdBy: req.user._id, createdAt: new Date() },
          activities: {
            type: 'note', description: 'Note added',
            performedBy: req.user._id, performedAt: new Date(),
          },
        },
      },
      { new: true }
    ).populate('notes.createdBy', 'name').lean();

    if (!lead) return next(new AppError('Lead not found.', 404));
    res.status(201).json({ success: true, data: { notes: lead.notes } });
  } catch (err) { next(err); }
};

// ── POST /leads/import — bulk create from parsed CSV rows ────────────────
exports.bulkImport = async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.leads) ? req.body.leads : [];
    if (!rows.length) return next(new AppError('No rows to import.', 400));
    if (rows.length > 2000) return next(new AppError('Import is limited to 2000 rows at a time.', 400));

    const errors = [];
    const valid = [];
    const seenInFile = new Set();

    rows.forEach((row, idx) => {
      const rowNum = idx + 1;
      const name = String(row.name ?? '').trim();
      const email = String(row.email ?? '').trim().toLowerCase();

      if (!name || !email) { errors.push({ row: rowNum, reason: 'Missing name or email' }); return; }
      if (!/^\S+@\S+\.\S+$/.test(email)) { errors.push({ row: rowNum, reason: `Invalid email: ${email}` }); return; }
      if (seenInFile.has(email)) { errors.push({ row: rowNum, reason: `Duplicate row in file: ${email}` }); return; }
      seenInFile.add(email);

      const status = String(row.status ?? '').trim().toLowerCase();
      valid.push({
        companyId: req.companyId,
        createdBy: req.user._id,
        name,
        email,
        phone: String(row.phone ?? '').trim() || undefined,
        company: String(row.company ?? '').trim() || undefined,
        status: LEAD_STATUSES.includes(status) ? status : 'new',
        source: 'other',
      });
    });

    let imported = 0;
    let skipped = 0;

    if (valid.length) {
      const existing = new Set(
        (await Lead.find({ companyId: req.companyId, email: { $in: valid.map((v) => v.email) } })
          .select('email').lean()).map((l) => l.email)
      );
      const toCreate = valid.filter((v) => {
        if (existing.has(v.email)) { skipped++; return false; }
        return true;
      });
      if (toCreate.length) {
        const created = await Lead.insertMany(toCreate, { ordered: false });
        imported = created.length;
      }
    }

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id, action: 'lead.bulk_import',
      description: `CSV import: ${imported} imported, ${skipped} skipped, ${errors.length} errors`, ip: req.ip,
    });

    res.status(200).json({ success: true, imported, skipped, errors });
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
