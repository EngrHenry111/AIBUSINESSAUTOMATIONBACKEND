'use strict';

/**
 * Sales follow-up: no interested customer goes unremembered.
 *
 *  1. Stage tracking — after a chat, the AI reads it and records where the
 *     customer is (browsing → interested → ready to buy), which products they
 *     want, and moves their lead forward on the pipeline (never backwards,
 *     never to won/lost: a purchase marks won, people decide lost).
 *  2. Follow-ups — an interested WhatsApp customer who goes quiet gets ONE
 *     friendly nudge from the AI, a few hours later and inside WhatsApp's free
 *     24-hour window, with the product's live price and stock. Another nudge
 *     only after they write again.
 *  3. Team reminders — hot customers waiting on a person for over an hour are
 *     emailed to whoever has the chat (or the owner).
 *
 * Settings: Company.leadCapture.{aiStages, followUps, followUpAfterHours, teamReminders}.
 * Nothing here throws into a chat reply.
 */
const Conversation = require('../../models/Conversation');
const Company = require('../../models/Company');
const Contact = require('../../models/Contact');
const Lead = require('../../models/Lead');
const User = require('../../models/User');
const logger = require('../../utils/logger');
const { classifySale, generateFollowUp, SKIP_TOKEN } = require('../groqService');
const { catalogContext } = require('./salesContext');
const channels = require('./channels');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Channels where the business can reach a quiet customer (WhatsApp: free
// inside 24h of their last message; Telegram has no limit, but a nudge
// a day later would feel stale, so the same window applies).
const FOLLOW_UP_CHANNELS = ['whatsapp', 'telegram'];
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram', widget: 'Website chat' };
const WINDOW_MS = 23 * HOUR;          // stay safely inside the 24h window
const ANALYZE_EVERY_MS = 10 * MIN;    // at most one stage check per chat per 10 min
const ANALYSES_PER_DAY = 300;         // per company — keeps the AI bill at zero on free tiers
const FOLLOW_UPS_PER_RUN = 50;
const TEAM_WAIT_MS = HOUR;
const HOT = ['interested', 'ready_to_buy'];
const OPEN_PIPELINE = ['new', 'contacted', 'qualified', 'proposal', 'negotiation'];
const STAGE_TO_LEAD = { browsing: 'contacted', interested: 'qualified', ready_to_buy: 'negotiation' };
const STAGE_LABEL = { browsing: 'browsing', interested: 'interested', ready_to_buy: 'ready to buy', ordered: 'says they ordered', not_interested: 'not interested', support: 'needs help with an order' };
const OPT_OUT = /\b(stop|unsubscribe|not interested|no thanks|no thank you|leave me alone|don'?t (message|contact|text) me)\b/i;

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emit = (companyId, event, payload) => {
  try { global.io?.to(`company:${companyId}`).emit(event, payload); } catch { /* live update only */ }
};

// ── Settings (cached a minute) ────────────────────────────────────────────
const settingsCache = new Map();
async function settingsFor(companyId) {
  const key = String(companyId);
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < MIN) return hit.value;
  const c = await Company.findById(companyId).select('companyName status owner logo leadCapture').lean();
  const lc = c?.leadCapture || {};
  const value = c ? {
    company: c,
    aiStages: lc.aiStages !== false,
    followUps: lc.followUps !== false,
    followUpAfterHours: Math.min(20, Math.max(1, Number(lc.followUpAfterHours) || 3)),
    teamReminders: lc.teamReminders !== false,
    active: c.status !== 'suspended' && c.status !== 'inactive',
  } : null;
  settingsCache.set(key, { at: Date.now(), value });
  return value;
}

// Daily AI budget per company (in memory: a restart only resets it early).
const budget = new Map();
function takeBudget(companyId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${companyId}:${day}`;
  const used = budget.get(key) || 0;
  if (used >= ANALYSES_PER_DAY) return false;
  budget.set(key, used + 1);
  if (budget.size > 5000) budget.clear();
  return true;
}

function transcriptOf(messages) {
  return messages
    .filter((m) => m.from !== 'system' || m.notice)
    .slice(-14)
    .map((m) => `${m.from === 'customer' ? 'Customer' : 'Business'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
}

async function leadFor(convo) {
  if (convo.contactId) {
    const contact = await Contact.findById(convo.contactId).select('leadId').lean();
    if (contact?.leadId) {
      const lead = await Lead.findOne({ _id: contact.leadId, companyId: convo.companyId });
      if (lead) return lead;
    }
  }
  const or = [];
  if (convo.email) or.push({ email: convo.email });
  const key = Lead.phoneKeyOf(convo.phone);
  if (key) or.push({ phoneKey: key });
  return or.length ? Lead.findOne({ companyId: convo.companyId, $or: or }).sort({ createdAt: -1 }) : null;
}

// ── 1. Stage tracking ─────────────────────────────────────────────────────
/**
 * Works out where this customer is and moves their lead along.
 * @param {Object} convo  Conversation (doc or lean) with recent messages
 * @param {Object} [opts]
 * @param {boolean} [opts.force]  ignore the 10-minute spacing
 * @returns {Promise<Object|null>} the stored sales info, or null if skipped
 */
async function analyzeConversation(convo, { force = false } = {}) {
  try {
    const messages = convo.messages || [];
    if (!messages.some((m) => m.from === 'customer')) return null;
    const sales = convo.sales || {};
    // Nothing new from the customer since the last check.
    if (sales.analyzedAt && convo.lastCustomerAt && new Date(sales.analyzedAt) >= new Date(convo.lastCustomerAt)) return null;
    if (!force && sales.analyzedAt && Date.now() - new Date(sales.analyzedAt) < ANALYZE_EVERY_MS) return null;

    const settings = await settingsFor(convo.companyId);
    if (!settings?.aiStages || !settings.active) return null;
    if (!takeBudget(convo.companyId)) return null;

    const result = await classifySale({ businessName: settings.company.companyName, transcript: transcriptOf(messages) });
    if (!result) return null;

    const stored = {
      stage: result.stage,
      products: result.products.length ? result.products : undefined,
      summary: result.summary || undefined,
      analyzedAt: new Date(),
    };
    await Conversation.updateOne({ _id: convo._id }, { $set: { sales: stored } });
    if (typeof convo.set !== 'function') convo.sales = stored; // plain objects only; a document saves its own fields

    await moveLead(convo, result);
    emit(convo.companyId, 'inbox:conversation_updated', { conversationId: convo._id, sales: stored });
    return stored;
  } catch (err) {
    logger.warn(`Sales stage check failed (conversation ${convo?._id}): ${err.message}`);
    return null;
  }
}

async function moveLead(convo, result) {
  const lead = await leadFor(convo);
  if (!lead) return;
  let changed = false;
  const now = new Date();

  if (result.products.length) {
    const merged = [...new Set([...(lead.interestedIn || []), ...result.products])].slice(-10);
    if (merged.join('|') !== (lead.interestedIn || []).join('|')) { lead.interestedIn = merged; changed = true; }
  }
  const target = STAGE_TO_LEAD[result.stage];
  if (target && OPEN_PIPELINE.includes(lead.status)
    && OPEN_PIPELINE.indexOf(target) > OPEN_PIPELINE.indexOf(lead.status)) {
    const about = result.products.length ? ` (${result.products.slice(0, 3).join(', ')})` : '';
    lead.activities.push({
      type: 'status_change',
      description: `Status changed from ${lead.status} to ${target} — AI: customer is ${STAGE_LABEL[result.stage]}${about}`,
      performedAt: now,
    });
    lead.status = target;
    // An interested customer deserves a look soon.
    if (!lead.nextFollowUpAt || lead.nextFollowUpAt > new Date(now.getTime() + 24 * HOUR)) lead.nextFollowUpAt = new Date(now.getTime() + 24 * HOUR);
    changed = true;
  }
  if (result.estimatedValue > 0 && !lead.value && OPEN_PIPELINE.includes(lead.status)) { lead.value = result.estimatedValue; changed = true; }
  if (result.summary && lead.ai?.summary !== result.summary && OPEN_PIPELINE.includes(lead.status)) {
    lead.set('ai.summary', result.summary);
    changed = true;
  }
  if (!changed) return;
  await lead.save();
  emit(convo.companyId, 'leads:update', { leadId: lead._id, stage: result.stage });
}

/** Called after each customer message is answered (fire and forget). */
function afterMessage(convo, leadReady) {
  Promise.resolve(leadReady).catch(() => {}).then(() => analyzeConversation(convo)).catch(() => {});
}

// ── 2. Follow-ups ─────────────────────────────────────────────────────────
const notYetFollowedUp = {
  $or: [
    { 'followUp.forCustomerAt': { $exists: false } },
    { 'followUp.forCustomerAt': null },
    { $expr: { $lt: ['$followUp.forCustomerAt', '$lastCustomerAt'] } },
  ],
};

async function sendFollowUp(convo, settings) {
  const messages = convo.messages || [];
  const last = messages[messages.length - 1];
  const lastCustomer = [...messages].reverse().find((m) => m.from === 'customer');
  // The customer is waiting on us, not the other way round.
  if (!last || last.from === 'customer') return 'customer_waiting';

  // Claim this silence first, so two servers (or two runs) never both send.
  const claim = await Conversation.updateOne(
    { _id: convo._id, lastCustomerAt: convo.lastCustomerAt, ...notYetFollowedUp },
    { $set: { 'followUp.forCustomerAt': convo.lastCustomerAt } },
  );
  if (!claim.modifiedCount) return 'taken';

  if (lastCustomer && OPT_OUT.test(lastCustomer.content || '')) return 'opted_out';
  const lead = await leadFor(convo);
  if (lead && ['won', 'lost', 'converted'].includes(lead.status)) return 'lead_closed';

  const interest = (convo.sales?.products || []).join(', ');
  const catalog = await catalogContext(convo.companyId, interest || transcriptOf(messages.slice(-4)));
  const history = messages
    .filter((m) => m.from !== 'system' || m.notice)
    .slice(-10)
    .map((m) => ({ role: m.from === 'customer' ? 'user' : 'assistant', content: m.content }));
  const name = convo.displayName && convo.displayName !== convo.phone && !/^\+?\d[\d\s-]+$/.test(convo.displayName) ? convo.displayName : '';

  const text = await generateFollowUp({
    businessName: catalog.businessName || settings.company.companyName,
    catalog: catalog.text,
    customerName: name.split(' ')[0],
    interest,
    history,
  });
  if (text === SKIP_TOKEN) return 'ai_skipped';

  const result = await channels.deliver(convo, text);
  if (!result.success) {
    logger.warn(`Follow-up not delivered (conversation ${convo._id}): ${result.reason}`);
    return 'not_delivered';
  }
  const now = new Date();
  const message = { from: 'ai', content: text, agentName: 'AI follow-up', followUp: true, read: true, timestamp: now };
  await Conversation.updateOne({ _id: convo._id }, {
    $push: { messages: message },
    $set: { lastMessageAt: now, 'followUp.sentAt': now },
    $inc: { 'followUp.count': 1 },
  });
  const saved = await Conversation.findById(convo._id).select({ messages: { $slice: -1 } }).lean();
  emit(convo.companyId, 'inbox:new_message', { conversationId: convo._id, channel: convo.channel, message: saved?.messages?.[0] || message, status: convo.status });

  if (lead) {
    lead.activities.push({ type: ['whatsapp', 'telegram'].includes(convo.channel) ? convo.channel : 'chat', description: `AI follow-up sent: "${text.slice(0, 200)}"`, performedAt: now });
    lead.lastContactedAt = now;
    await lead.save().catch(() => {});
    emit(convo.companyId, 'leads:update', { leadId: lead._id });
  }
  return 'sent';
}

// ── 3. Team reminders ─────────────────────────────────────────────────────
async function remindTeams(now) {
  const waiting = await Conversation.find({
    status: 'human',
    lastCustomerAt: { $lte: new Date(now - TEAM_WAIT_MS), $gte: new Date(now - 24 * HOUR) },
    'sales.stage': { $in: HOT },
    $or: [
      { 'followUp.teamRemindedAt': { $exists: false } },
      { 'followUp.teamRemindedAt': null },
      { $expr: { $lt: ['$followUp.teamRemindedAt', '$lastCustomerAt'] } },
    ],
  }).select({ companyId: 1, assignedTo: 1, displayName: 1, phone: 1, channel: 1, sales: 1, lastCustomerAt: 1, messages: { $slice: -1 } }).limit(500).lean();

  const groups = new Map(); // companyId|userId → chats
  for (const c of waiting) {
    if (c.messages?.[0]?.from !== 'customer') continue; // someone already answered
    // eslint-disable-next-line no-await-in-loop
    const settings = await settingsFor(c.companyId);
    if (!settings?.teamReminders || !settings.active) continue;
    const to = String(c.assignedTo || settings.company.owner || '');
    if (!to) continue;
    const key = `${c.companyId}|${to}`;
    if (!groups.has(key)) groups.set(key, { settings, userId: to, chats: [] });
    groups.get(key).chats.push(c);
  }

  let reminded = 0;
  const emailService = require('../emailService');
  for (const { settings, userId, chats } of groups.values()) {
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findById(userId).select('name email status').lean();
    if (!user?.email || user.status === 'inactive') continue;
    const n = chats.length;
    const rows = chats.slice(0, 15).map((c) => `
      <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
        <strong style="color:#0f172a;">${escapeHtml(c.displayName || c.phone || 'Customer')}</strong>
        <span style="color:#64748b;font-size:12px;"> · ${CHANNEL_LABEL[c.channel] || 'Chat'} · ${STAGE_LABEL[c.sales.stage]} · waiting ${Math.round((now - new Date(c.lastCustomerAt)) / HOUR)}h</span>
        ${c.sales.summary ? `<div style="color:#475569;font-size:13px;margin-top:2px;">${escapeHtml(c.sales.summary)}</div>` : ''}
        <div style="color:#64748b;font-size:12px;margin-top:2px;">Last message: "${escapeHtml(String(c.messages[0].content || '').slice(0, 140))}"</div>
      </td></tr>`).join('');
    const subject = n === 1
      ? `${chats[0].displayName || 'A customer'} is ready to buy and waiting for a reply`
      : `${n} interested customers are waiting for a reply`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await emailService.send({
        to: user.email,
        subject,
        html: emailService.baseTemplate('Customers waiting', `
          <h2 style="color:#0f172a;margin:0 0 6px;">Hi ${escapeHtml((user.name || '').split(' ')[0] || 'there')}, ${n === 1 ? 'a customer is' : `${n} customers are`} waiting</h2>
          <p style="color:#475569;font-size:14px;">They showed interest in buying from <strong>${escapeHtml(settings.company.companyName)}</strong> and the chat is with your team. A quick reply can win the sale.</p>
          <table style="width:100%;border-collapse:collapse;">${rows}</table>
          <p style="margin-top:16px;"><a href="${clientUrl()}/inbox" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Open Inbox</a></p>
        `, { name: settings.company.companyName, logo: settings.company.logo }),
      });
    } catch (err) {
      logger.warn(`Waiting-customer reminder to ${userId} failed: ${err.message}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await Conversation.updateMany({ _id: { $in: chats.map((c) => c._id) } }, { $set: { 'followUp.teamRemindedAt': new Date(now) } });
    reminded += n;
  }
  return reminded;
}

// ── The job (every 15 minutes) ────────────────────────────────────────────
let running = false;
async function runSalesFollowUps() {
  if (running) return { skipped: true };
  running = true;
  const stats = { analyzed: 0, sent: 0, skipped: 0, reminded: 0 };
  try {
    const now = Date.now();

    // a) Catch up on chats that went quiet since their last stage check.
    const stale = await Conversation.find({
      lastCustomerAt: { $gte: new Date(now - 24 * HOUR), $lte: new Date(now - ANALYZE_EVERY_MS) },
      status: { $ne: 'resolved' },
      $or: [{ 'sales.analyzedAt': { $exists: false } }, { $expr: { $lt: ['$sales.analyzedAt', '$lastCustomerAt'] } }],
    }).select({ companyId: 1, channel: 1, contactId: 1, email: 1, phone: 1, sales: 1, lastCustomerAt: 1, messages: { $slice: -14 } }).limit(100).lean();
    for (const c of stale) {
      // eslint-disable-next-line no-await-in-loop
      if (await analyzeConversation(c, { force: true })) stats.analyzed += 1;
    }

    // b) Nudge interested customers who went quiet.
    const due = await Conversation.find({
      channel: { $in: FOLLOW_UP_CHANNELS },
      status: 'ai',
      lastCustomerAt: { $gte: new Date(now - WINDOW_MS), $lte: new Date(now - HOUR) },
      'sales.stage': { $in: HOT },
      ...notYetFollowedUp,
    }).select({ companyId: 1, channel: 1, externalId: 1, contactId: 1, email: 1, phone: 1, displayName: 1, status: 1, sales: 1, meta: 1, lastCustomerAt: 1, messages: { $slice: -12 } })
      .sort({ lastCustomerAt: 1 }).limit(FOLLOW_UPS_PER_RUN).lean();
    for (const c of due) {
      // eslint-disable-next-line no-await-in-loop
      const settings = await settingsFor(c.companyId);
      if (!settings?.followUps || !settings.active) continue;
      if (now - new Date(c.lastCustomerAt) < settings.followUpAfterHours * HOUR) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await sendFollowUp(c, settings);
        if (outcome === 'sent') stats.sent += 1; else stats.skipped += 1;
      } catch (err) {
        stats.skipped += 1;
        logger.warn(`Follow-up failed (conversation ${c._id}): ${err.message}`);
      }
    }

    // c) Hot customers left waiting on the team.
    stats.reminded = await remindTeams(now);

    if (stats.sent || stats.reminded) logger.warn(`Sales follow-ups: ${stats.sent} sent, ${stats.reminded} waiting chat(s) reminded, ${stats.analyzed} chats checked`);
    return stats;
  } catch (err) {
    logger.warn(`Sales follow-up run failed: ${err.message}`);
    return { ...stats, error: err.message };
  } finally {
    running = false;
  }
}

module.exports = {
  analyzeConversation, afterMessage, runSalesFollowUps, sendFollowUp,
  _forget: () => { settingsCache.clear(); budget.clear(); },
};
