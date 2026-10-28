'use strict';

/**
 * Automatic lead capture. Website chat, WhatsApp, the online store and the
 * digital business card call captureLead() whenever a person leaves an email
 * or phone number; buying anything calls markLeadWon() (via customerSync).
 *
 * One person = one lead: an existing lead with the same email, or the same
 * phone (last 10 digits), is updated instead of a new one being created.
 * Nothing here ever throws — a lead problem must never break a chat reply,
 * a WhatsApp answer or a checkout.
 */
const Lead = require('../models/Lead');
const Company = require('../models/Company');
const logger = require('./logger');
const { analyzeLeadRecord } = require('./leadAnalysis');

// Lead source → Company.leadCapture switch that controls it.
const CHANNEL_OF = { chat_widget: 'chat', whatsapp: 'whatsapp', store: 'store', business_card: 'card' };
const CLOSED = ['won', 'lost', 'converted'];
// Repeat messages within this window update the lead without adding another
// timeline entry, so a 20-message chat is one activity, not twenty.
const QUIET_MS = 30 * 60 * 1000;
const FIRST_FOLLOW_UP_MS = 24 * 60 * 60 * 1000;
const AI_SCORES_PER_DAY = 30;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Nigerian mobile numbers, local (080…) or international (+234 80…).
const PHONE_RE = /(?:\+?234[\s-]?|0)[789][01]\d(?:[\s-]?\d){7}/;

const excerpt = (text, n = 140) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Pulls an email address / phone number a visitor typed into a message.
function contactFromText(text) {
  const s = String(text || '');
  return { email: EMAIL_RE.exec(s)?.[0]?.toLowerCase(), phone: PHONE_RE.exec(s)?.[0] };
}

function emitUpdate(companyId, payload) {
  try { global.io?.to(`company:${companyId}`).emit('leads:update', payload); } catch { /* live update only */ }
}

function matchFor(companyId, email, phoneKey) {
  const or = [];
  if (email) or.push({ email });
  if (phoneKey) or.push({ phoneKey });
  return or.length ? { companyId, $or: or } : null;
}

async function autoScore(lead) {
  try {
    const company = await Company.findById(lead.companyId).select('leadCapture').lean();
    if (company?.leadCapture?.aiScoring === false) return;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const scoredToday = await Lead.countDocuments({ companyId: lead.companyId, 'ai.analyzedAt': { $gte: startOfDay } });
    if (scoredToday >= AI_SCORES_PER_DAY) return;
    await analyzeLeadRecord(lead);
    emitUpdate(lead.companyId, { leadId: lead._id, scored: true });
  } catch (err) {
    logger.warn(`Lead auto-score failed: ${err.message}`);
  }
}

/**
 * @param {ObjectId} companyId
 * @param {Object}   p
 * @param {string}   p.source        chat_widget | whatsapp | store | business_card
 * @param {string}   [p.name]
 * @param {string}   [p.email]
 * @param {string}   [p.phone]
 * @param {string}   [p.company]
 * @param {string}   p.activity      what happened, for the lead's timeline
 * @param {string}   [p.activityType] chat | whatsapp | order | system …
 * @param {ObjectId} [p.assignedTo]  owner for a NEW lead (e.g. the card's owner)
 * @returns {Promise<{lead, created}|null>}
 */
async function captureLead(companyId, {
  source, name, email, phone, company, activity, activityType = 'system', assignedTo,
} = {}) {
  try {
    if (!companyId || !CHANNEL_OF[source]) return null;
    const settings = await Company.findById(companyId).select('leadCapture').lean();
    if (!settings || settings.leadCapture?.[CHANNEL_OF[source]] === false) return null;

    const cleanEmail = EMAIL_RE.test(String(email || '')) ? String(email).trim().toLowerCase() : undefined;
    const cleanPhone = String(phone || '').trim() || undefined;
    const phoneKey = Lead.phoneKeyOf(cleanPhone);
    const match = matchFor(companyId, cleanEmail, phoneKey);
    if (!match) return null;

    const now = new Date();
    const cleanName = String(name || '').trim().slice(0, 120);
    const entry = activity ? { type: activityType, description: excerpt(activity, 300), performedAt: now } : null;
    const lead = await Lead.findOne(match).sort({ createdAt: -1 });

    if (lead) {
      const placeholder = !lead.name || lead.name === lead.email || lead.name === lead.phone;
      if (cleanName && placeholder) lead.name = cleanName;
      if (cleanEmail && !lead.email) lead.email = cleanEmail;
      if (cleanPhone && !lead.phone) lead.phone = cleanPhone;
      if (company && !lead.company) lead.company = company;

      const quiet = lead.lastContactedAt && now - lead.lastContactedAt < QUIET_MS
        && lead.activities?.[lead.activities.length - 1]?.type === activityType;
      if (entry && !quiet) lead.activities.push(entry);
      // Someone written off as lost who gets back in touch is worth a look.
      if (lead.status === 'lost') {
        lead.activities.push({ type: 'status_change', description: 'Got back in touch — reopened from lost to new', performedAt: now });
        lead.status = 'new';
        lead.nextFollowUpAt = new Date(now.getTime() + FIRST_FOLLOW_UP_MS);
      }
      lead.lastContactedAt = now;
      await lead.save();
      emitUpdate(companyId, { leadId: lead._id, created: false });
      return { lead, created: false };
    }

    const created = await Lead.create({
      companyId,
      name: cleanName || cleanEmail || cleanPhone,
      email: cleanEmail,
      phone: cleanPhone,
      company: company || undefined,
      source,
      status: 'new',
      autoCaptured: true,
      assignedTo: assignedTo || undefined,
      lastContactedAt: now,
      nextFollowUpAt: new Date(now.getTime() + FIRST_FOLLOW_UP_MS),
      activities: entry ? [entry] : [],
    });
    emitUpdate(companyId, { leadId: created._id, created: true });
    autoScore(created); // in the background — never holds up the caller
    return { lead: created, created: true };
  } catch (err) {
    logger.warn(`Lead capture (${source}) failed: ${err.message}`);
    return null;
  }
}

/**
 * A purchase or paid invoice: if this person is a lead, mark it won, note
 * the sale on its timeline and link it to their customer record.
 */
async function markLeadWon(companyId, { email, phone } = {}, { amount = 0, label = 'Made a purchase', customer } = {}) {
  try {
    const cleanEmail = String(email || '').trim().toLowerCase() || undefined;
    const match = matchFor(companyId, cleanEmail, Lead.phoneKeyOf(phone));
    if (!match) return null;
    const lead = await Lead.findOne(match).sort({ createdAt: -1 });
    if (!lead) return null;

    const now = new Date();
    const money = amount ? ` — ₦${Number(amount).toLocaleString()}` : '';
    lead.activities.push({ type: 'order', description: `${label}${money}`, performedAt: now });
    if (!CLOSED.includes(lead.status)) {
      lead.activities.push({ type: 'status_change', description: `Status changed from ${lead.status} to won (they bought — updated automatically)`, performedAt: now });
      lead.status = 'won';
      lead.nextFollowUpAt = undefined;
      if (!lead.value && amount) lead.value = Number(amount);
    }
    lead.lastContactedAt = now;
    await lead.save();

    if (customer && !customer.convertedFromLead) {
      customer.convertedFromLead = lead._id;
      await customer.save().catch(() => {});
    }
    emitUpdate(companyId, { leadId: lead._id, won: true });
    return lead;
  } catch (err) {
    logger.warn(`Lead win update failed: ${err.message}`);
    return null;
  }
}

// One-off on startup: give leads saved before phoneKey existed their key,
// so a WhatsApp message matches a lead someone typed in by hand.
async function backfillPhoneKeys() {
  try {
    const cursor = Lead.find({ phone: { $nin: [null, ''] }, phoneKey: { $exists: false } }).select('phone').lean().cursor();
    let n = 0;
    for await (const l of cursor) {
      const key = Lead.phoneKeyOf(l.phone);
      if (key) { await Lead.updateOne({ _id: l._id }, { phoneKey: key }); n += 1; }
    }
    if (n) logger.info(`Lead phone keys backfilled: ${n}`);
  } catch (err) { logger.warn(`Lead phone key backfill failed: ${err.message}`); }
}

module.exports = { captureLead, markLeadWon, contactFromText, backfillPhoneKeys, excerpt };
