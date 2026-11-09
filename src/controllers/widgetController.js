'use strict';

const Company = require('../models/Company');
const Conversation = require('../models/Conversation');
const inbox = require('../services/inbox');
const { AppError } = require('../middleware/errorMiddleware');

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
    const result = await inbox.receiveMessage({
      companyId: company._id,
      channel: 'widget',
      externalId: String(sessionId).slice(0, 100),
      text: String(message).trim().slice(0, 4000),
      name: ws.collectEmail && visitorName ? String(visitorName).slice(0, 120) : undefined,
      email: ws.collectEmail && visitorEmail ? String(visitorEmail).slice(0, 160) : undefined,
      meta: { originHost: originHostOf(req), ipAddress: req.ip, userAgent: req.headers['user-agent'] },
      ai: { floor: 0.05, topK: 5, keywordHandover: false },
      noAnswer: { reply: ws.offlineMessage || DEFAULTS.offlineMessage, handover: ws.humanHandoverEnabled !== false },
    });

    // Source document names stay with the team (saved on the conversation),
    // not sent to the visitor. reply is null while a team member is handling
    // the chat — their answer arrives through the history poll.
    res.status(200).json({
      success: true,
      data: { reply: result.reply, waitingForHuman: result.waitingForHuman, sessionId },
    });
  } catch (err) { next(err); }
};

// What the visitor sees: their messages, the replies, and notices sent to them.
function visitorMessages(convo) {
  return convo.messages
    .filter((m) => m.from !== 'system' || m.notice)
    .map((m) => ({
      id: String(m._id),
      role: m.from === 'customer' ? 'user' : 'assistant',
      from: m.from === 'human' ? 'team' : m.from === 'system' ? 'notice' : m.from,
      agentName: m.from === 'human' ? m.agentName : undefined,
      content: m.content,
      timestamp: m.timestamp,
    }));
}

exports.getWidgetHistory = async (req, res, next) => {
  try {
    const company = await findByCompanySlug(req.params.companySlug);
    if (!company) return next(new AppError('Not found.', 404));

    const convo = await Conversation.findOne({
      companyId: company._id, channel: 'widget', externalId: String(req.params.sessionId),
    }).sort({ lastMessageAt: -1 }).lean();
    if (!convo || Date.now() - new Date(convo.lastMessageAt).getTime() > SESSION_TTL_MS) {
      return res.status(200).json({ success: true, data: { messages: [] } });
    }

    res.status(200).json({
      success: true,
      data: { messages: visitorMessages(convo), status: convo.status },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════
// PROTECTED — business owner / team, scoped to req.companyId
// ═══════════════════════════════════════════════════════════════════════

// Conversations live in the shared inbox — see controllers/inboxController.js.

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
