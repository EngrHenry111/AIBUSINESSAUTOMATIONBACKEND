'use strict';

const Company = require('../models/Company');
const DocumentChunk = require('../models/DocumentChunk');
const WidgetConversation = require('../models/WidgetConversation');
const { getEmbedding } = require('../services/embeddingService');
const { generateWhatsAppReply } = require('../services/groqService');
const { hybridSearch, rerankChunks } = require('../utils/hybridSearch');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');

const io = (req) => req.app.get('io');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // widget sessions expire after 24h
const DEFAULTS = {
  greeting: 'Hi! How can I help you today?',
  placeholder: 'Ask me anything...',
  primaryColor: '#6366f1',
  position: 'bottom-right',
  offlineMessage: "I couldn't find an answer to that. A team member will follow up with you soon.",
};

// ── Public config allowlist — never leak companyId or internal fields ──────
function publicWidgetConfig(company) {
  const ws = company.widgetSettings || {};
  return {
    companyName: company.companyName,
    primaryColor: ws.primaryColor || company.storeSettings?.primaryColor || DEFAULTS.primaryColor,
    // A business that hasn't set its own greeting still gets one that names
    // their store rather than the generic default — customized greetings
    // always win.
    greeting: ws.greeting || `Hi! Welcome to ${company.companyName}. How can I help you today?`,
    placeholder: ws.placeholder || DEFAULTS.placeholder,
    position: ws.position || DEFAULTS.position,
    avatar: company.logo || null,
    collectEmail: Boolean(ws.collectEmail),
    isOnline: true,
  };
}

function findByCompanySlug(slug) {
  return Company.findOne({ storeSlug: String(slug || '').toLowerCase(), status: 'active' });
}

// A request's Origin (or Referer as a fallback) tells us which site the
// widget script is running on. No header at all (curl, some in-app
// webviews) is treated as "unknown" rather than blocked outright.
function originHostOf(req) {
  const raw = req.headers.origin || req.headers.referer || '';
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const OWN_DOMAINS = ['bislyai.com'];
function isOwnDomain(host) {
  if (!host) return true; // unknown origin — don't penalize, treat as first-party
  return OWN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// Enforce the pricing tiers on embedding the widget on an EXTERNAL site:
// starter → not included at all; professional → 1 external domain;
// business/enterprise → unlimited. Trial gets the same unlimited access as
// business so a prospect can actually evaluate the feature before paying for
// it — gating it during the trial would just suppress the thing that's
// supposed to convert them. A company's own bislyai.com store is always
// free regardless of plan. Domains are auto-registered on first use.
async function enforceEmbedPlan(company, req) {
  const host = originHostOf(req);
  if (isOwnDomain(host)) return { ok: true };

  const plan = company.subscription?.plan;
  if (plan === 'starter' || !plan) {
    return { ok: false, message: 'Embedding the chat widget on an external website requires a Professional or Business plan.' };
  }

  const registered = company.widgetSettings?.externalDomains || [];
  if (registered.includes(host)) return { ok: true };

  const cap = plan === 'professional' ? 1 : Infinity; // trial/business/enterprise → unlimited
  if (registered.length >= cap) {
    return { ok: false, message: `Your plan allows the widget on ${cap} external website${cap === 1 ? '' : 's'}. Upgrade to add more.` };
  }

  await Company.findByIdAndUpdate(company._id, { $addToSet: { 'widgetSettings.externalDomains': host } });
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC — no auth
// ═══════════════════════════════════════════════════════════════════════

exports.getWidgetConfig = async (req, res, next) => {
  try {
    const company = await findByCompanySlug(req.params.companySlug);
    if (!company || company.widgetSettings?.widgetEnabled === false) {
      return res.status(404).json({ success: false, message: 'Chat widget not available.' });
    }
    const gate = await enforceEmbedPlan(company, req);
    if (!gate.ok) return res.status(403).json({ success: false, message: gate.message });

    res.status(200).json({ success: true, data: publicWidgetConfig(company) });
  } catch (err) { next(err); }
};

exports.handleWidgetMessage = async (req, res, next) => {
  try {
    const { message, sessionId, visitorName, visitorEmail } = req.body;
    if (!message?.trim()) return next(new AppError('A message is required.', 400));
    if (!sessionId) return next(new AppError('A session id is required.', 400));

    const company = await findByCompanySlug(req.params.companySlug);
    if (!company || company.widgetSettings?.widgetEnabled === false) {
      return next(new AppError('Chat widget not available.', 404));
    }
    const gate = await enforceEmbedPlan(company, req);
    if (!gate.ok) return next(new AppError(gate.message, 403));

    const ws = company.widgetSettings || {};
    const host = originHostOf(req);

    let convo = await WidgetConversation.findOne({ companyId: company._id, sessionId });
    if (!convo) {
      convo = new WidgetConversation({
        companyId: company._id,
        sessionId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        originHost: host,
      });
    }
    if (ws.collectEmail && visitorName && !convo.visitorName) convo.visitorName = String(visitorName).slice(0, 120);
    if (ws.collectEmail && visitorEmail && !convo.visitorEmail) convo.visitorEmail = String(visitorEmail).slice(0, 160);

    convo.messages.push({ role: 'user', content: message.trim(), read: true });

    // Knowledge-base lookup — same hybrid search the internal AI Assistant
    // uses, just answered in the short, conversational style used for
    // customer-facing chat (see generateWhatsAppReply).
    let questionEmbedding = null;
    try { questionEmbedding = await getEmbedding(message); }
    catch { logger.warn('Embedding service unavailable for widget chat, falling back to keyword-only search'); }

    const chunks = await DocumentChunk.find({ companyId: company._id }).lean();
    let reply;
    let sources = [];
    let noAnswer = false;

    if (!chunks.length) {
      noAnswer = true;
    } else {
      const searchResults = hybridSearch(chunks, questionEmbedding, message);
      const reranked = rerankChunks(searchResults, message);
      const topScore = reranked[0]?.rerankScore || 0;

      if (!reranked.length || topScore < 0.05) {
        noAnswer = true;
      } else {
        const topChunks = reranked.slice(0, 5);
        const context = topChunks.map((c) => c.chunk).join('\n\n---\n\n');
        const history = convo.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.content }));
        reply = await generateWhatsAppReply(context, message, history);
        sources = [...new Set(topChunks.map((c) => c.source))];
      }
    }

    if (noAnswer) {
      reply = ws.offlineMessage || DEFAULTS.offlineMessage;
      if (ws.humanHandoverEnabled !== false && !convo.handedToHuman) {
        convo.handedToHuman = true;
        convo.handoverRequestedAt = new Date();
      }
    }

    convo.messages.push({ role: 'assistant', content: reply, sources, sentBy: 'ai', read: false });
    convo.lastMessageAt = new Date();
    await convo.save();

    if (noAnswer) {
      io(req)?.to(`company:${company._id}`).emit('widget:handover_needed', {
        conversationId: convo._id, visitorName: convo.visitorName || null,
      });
    }
    io(req)?.to(`company:${company._id}`).emit('widget:new_message', { conversationId: convo._id });

    res.status(200).json({ success: true, data: { reply, sessionId, sources } });
  } catch (err) { next(err); }
};

exports.getWidgetHistory = async (req, res, next) => {
  try {
    const company = await findByCompanySlug(req.params.companySlug);
    if (!company) return next(new AppError('Not found.', 404));

    const convo = await WidgetConversation.findOne({ companyId: company._id, sessionId: req.params.sessionId }).lean();
    if (!convo || Date.now() - new Date(convo.lastMessageAt).getTime() > SESSION_TTL_MS) {
      return res.status(200).json({ success: true, data: { messages: [] } });
    }

    res.status(200).json({
      success: true,
      data: {
        messages: convo.messages.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp, sources: m.sources })),
      },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════
// PROTECTED — business owner / team, scoped to req.companyId
// ═══════════════════════════════════════════════════════════════════════

function listItem(c) {
  const msgs = c.messages || [];
  const last = msgs[msgs.length - 1];
  return {
    _id: c._id,
    visitorName: c.visitorName || null,
    visitorEmail: c.visitorEmail || null,
    displayName: c.visitorName || `Visitor #${String(c._id).slice(-4)}`,
    lastMessage: last ? last.content.slice(0, 90) : '',
    lastMessageFrom: last?.role || null,
    lastMessageAt: c.lastMessageAt,
    isResolved: c.isResolved,
    handedToHuman: c.handedToHuman,
    assignedTo: c.assignedTo || null,
    unread: msgs.filter((m) => m.role === 'user' && !m.read).length,
    createdAt: c.createdAt,
    originHost: c.originHost || null,
  };
}

exports.getWidgetConversations = async (req, res, next) => {
  try {
    const { filter = 'all', search } = req.query;
    const q = { companyId: req.companyId };
    if (filter === 'active') { q.isResolved = false; q.handedToHuman = false; }
    else if (filter === 'needs_human') { q.handedToHuman = true; q.isResolved = false; }
    else if (filter === 'resolved') q.isResolved = true;

    if (search?.trim()) {
      const rx = { $regex: search.trim(), $options: 'i' };
      q.$or = [{ visitorName: rx }, { visitorEmail: rx }, { sessionId: rx }];
    }

    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const activeThreshold = new Date(Date.now() - 5 * 60 * 1000);

    const [convos, totalToday, activeNow, needsHuman, resolved] = await Promise.all([
      WidgetConversation.find(q).populate('assignedTo', 'name').sort({ lastMessageAt: -1 }).limit(200).lean(),
      WidgetConversation.countDocuments({ companyId: req.companyId, createdAt: { $gte: startOfToday } }),
      WidgetConversation.countDocuments({ companyId: req.companyId, isResolved: false, lastMessageAt: { $gte: activeThreshold } }),
      WidgetConversation.countDocuments({ companyId: req.companyId, handedToHuman: true, isResolved: false }),
      WidgetConversation.countDocuments({ companyId: req.companyId, isResolved: true }),
    ]);

    res.status(200).json({
      success: true,
      data: convos.map(listItem),
      counts: { totalToday, activeNow, needsHuman, resolved },
    });
  } catch (err) { next(err); }
};

exports.getWidgetConversation = async (req, res, next) => {
  try {
    const convo = await WidgetConversation.findOne({ _id: req.params.id, companyId: req.companyId }).populate('assignedTo', 'name');
    if (!convo) return next(new AppError('Conversation not found.', 404));

    let touched = false;
    convo.messages.forEach((m) => { if (m.role === 'user' && !m.read) { m.read = true; touched = true; } });
    if (touched) await convo.save();

    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

exports.humanReply = async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return next(new AppError('Message is required.', 400));

    const convo = await WidgetConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));
    if (!convo.handedToHuman) return next(new AppError('Take over this conversation before replying.', 400));
    if (convo.assignedTo && String(convo.assignedTo) !== String(req.user._id)) {
      return next(new AppError('This conversation is assigned to another agent.', 403));
    }
    if (!convo.assignedTo) convo.assignedTo = req.user._id;

    convo.messages.push({ role: 'assistant', content: message.trim(), sentBy: 'human', agentName: req.user.name, read: true });
    convo.lastMessageAt = new Date();
    await convo.save();

    io(req)?.to(`company:${req.companyId}`).emit('widget:new_message', { conversationId: convo._id });

    res.status(200).json({ success: true, data: convo.messages[convo.messages.length - 1] });
  } catch (err) { next(err); }
};

exports.takeoverConversation = async (req, res, next) => {
  try {
    const convo = await WidgetConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));
    if (convo.assignedTo && String(convo.assignedTo) !== String(req.user._id)) {
      return next(new AppError('Already claimed by another agent.', 409));
    }

    convo.handedToHuman = true;
    convo.assignedTo = req.user._id;
    if (!convo.handoverRequestedAt) convo.handoverRequestedAt = new Date();
    await convo.save();

    io(req)?.to(`company:${req.companyId}`).emit('widget:conversation_updated', { conversationId: convo._id });

    const populated = await convo.populate('assignedTo', 'name');
    res.status(200).json({ success: true, data: populated });
  } catch (err) { next(err); }
};

exports.resolveConversation = async (req, res, next) => {
  try {
    const convo = await WidgetConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));

    convo.isResolved = true;
    convo.resolvedAt = new Date();
    await convo.save();

    io(req)?.to(`company:${req.companyId}`).emit('widget:conversation_updated', { conversationId: convo._id });
    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

exports.sendToAI = async (req, res, next) => {
  try {
    const convo = await WidgetConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));

    convo.handedToHuman = false;
    convo.assignedTo = null;
    convo.handoverRequestedAt = null;
    convo.isResolved = false;
    await convo.save();

    io(req)?.to(`company:${req.companyId}`).emit('widget:conversation_updated', { conversationId: convo._id });
    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

exports.getWidgetSettings = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('widgetSettings storeSlug storeEnabled subscription.plan');
    if (!company) return next(new AppError('Company not found.', 404));

    const ws = company.widgetSettings || {};
    res.status(200).json({
      success: true,
      data: {
        widgetEnabled: ws.widgetEnabled !== false,
        greeting: ws.greeting || DEFAULTS.greeting,
        placeholder: ws.placeholder || DEFAULTS.placeholder,
        primaryColor: ws.primaryColor || DEFAULTS.primaryColor,
        position: ws.position || DEFAULTS.position,
        collectEmail: Boolean(ws.collectEmail),
        offlineMessage: ws.offlineMessage || DEFAULTS.offlineMessage,
        humanHandoverEnabled: ws.humanHandoverEnabled !== false,
        externalDomains: ws.externalDomains || [],
        storeSlug: company.storeSlug,
        plan: company.subscription?.plan || 'trial',
      },
    });
  } catch (err) { next(err); }
};

exports.updateWidgetSettings = async (req, res, next) => {
  try {
    const allowed = ['widgetEnabled', 'greeting', 'placeholder', 'primaryColor', 'position', 'collectEmail', 'offlineMessage', 'humanHandoverEnabled'];
    const set = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) set[`widgetSettings.${key}`] = req.body[key];
    }
    const company = await Company.findByIdAndUpdate(req.companyId, { $set: set }, { new: true, runValidators: true })
      .select('widgetSettings storeSlug');
    if (!company) return next(new AppError('Company not found.', 404));

    res.status(200).json({ success: true, data: { ...company.widgetSettings.toObject(), storeSlug: company.storeSlug } });
  } catch (err) { next(err); }
};
