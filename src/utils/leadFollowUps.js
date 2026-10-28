'use strict';

/**
 * Hourly: email whoever owns each lead whose follow-up date has arrived —
 * the assigned teammate, or the company owner when nobody is assigned —
 * one digest per person. Each due date is reminded about once; setting a
 * new follow-up date arms it again. The bell icon shows the same leads
 * (notificationController) until they're dealt with.
 */
const Lead = require('../models/Lead');
const Company = require('../models/Company');
const User = require('../models/User');
const emailService = require('../services/emailService');
const logger = require('./logger');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Open leads whose follow-up is due and hasn't been reminded about yet.
const dueFilter = (now = new Date()) => ({
  nextFollowUpAt: { $lte: now },
  status: { $nin: ['won', 'lost', 'converted'] },
  $or: [
    { followUpRemindedAt: { $exists: false } },
    { followUpRemindedAt: null },
    { $expr: { $lt: ['$followUpRemindedAt', '$nextFollowUpAt'] } },
  ],
});

async function runLeadFollowUps() {
  try {
    const now = new Date();
    const due = await Lead.find(dueFilter(now))
      .select('companyId name email phone source status nextFollowUpAt assignedTo ai.recommendedAction')
      .sort({ nextFollowUpAt: 1 }).limit(1000).lean();
    if (!due.length) return { reminded: 0 };

    const companies = new Map((await Company.find({ _id: { $in: [...new Set(due.map((l) => String(l.companyId)))] } })
      .select('companyName owner status logo').lean()).map((c) => [String(c._id), c]));

    // recipient userId → leads
    const byUser = new Map();
    for (const lead of due) {
      const company = companies.get(String(lead.companyId));
      if (!company || company.status === 'suspended') continue;
      const to = String(lead.assignedTo || company.owner || '');
      if (!to) continue;
      if (!byUser.has(to)) byUser.set(to, { company, leads: [] });
      byUser.get(to).leads.push(lead);
    }

    const users = new Map((await User.find({ _id: { $in: [...byUser.keys()] }, status: 'active' }).select('name email').lean())
      .map((u) => [String(u._id), u]));

    let reminded = 0;
    for (const [userId, { company, leads }] of byUser) {
      const user = users.get(userId);
      if (!user?.email) continue;
      const rows = leads.slice(0, 25).map((l) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
            <a href="${clientUrl()}/leads/${l._id}" style="color:#0f172a;font-weight:600;text-decoration:none;">${escapeHtml(l.name)}</a>
            <div style="color:#64748b;font-size:12px;">${escapeHtml([l.email, l.phone].filter(Boolean).join(' · '))}</div>
            ${l.ai?.recommendedAction ? `<div style="color:#475569;font-size:12px;margin-top:2px;">Suggested: ${escapeHtml(l.ai.recommendedAction)}</div>` : ''}
          </td>
        </tr>`).join('');
      const more = leads.length > 25 ? `<p style="color:#64748b;font-size:13px;">…and ${leads.length - 25} more.</p>` : '';
      try {
        await emailService.send({
          to: user.email,
          subject: leads.length === 1 ? `Follow up with ${leads[0].name} today` : `${leads.length} leads to follow up today`,
          html: emailService.baseTemplate('Follow-ups due', `
            <h2 style="color:#0f172a;margin:0 0 6px;">Hi ${escapeHtml((user.name || '').split(' ')[0] || 'there')}, follow-ups are due</h2>
            <p style="color:#475569;font-size:14px;">These leads at <strong>${escapeHtml(company.companyName)}</strong> are waiting to hear from you:</p>
            <table style="width:100%;border-collapse:collapse;">${rows}</table>
            ${more}
            <p style="margin-top:16px;"><a href="${clientUrl()}/leads" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Open Leads</a></p>
          `, { name: company.companyName, logo: company.logo }),
        });
      } catch (err) {
        logger.warn(`Lead follow-up email to ${userId} failed: ${err.message}`);
        continue; // try again next hour
      }
      await Lead.updateMany({ _id: { $in: leads.map((l) => l._id) } }, { followUpRemindedAt: now });
      reminded += leads.length;
    }
    if (reminded) logger.info(`Lead follow-up reminders sent for ${reminded} lead(s)`);
    return { reminded };
  } catch (err) {
    logger.warn(`Lead follow-up run failed: ${err.message}`);
    return { reminded: 0, error: err.message };
  }
}

module.exports = { runLeadFollowUps, dueFilter };
