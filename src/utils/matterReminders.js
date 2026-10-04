'use strict';

// Emails the responsible lawyer and matter team before hearings, filing
// deadlines and limitation dates — 7 days ahead and 1 day ahead, once each.
// A missed court date or limitation period is the costliest mistake a
// practice can make, so this runs hourly from server.js like the other
// reminder jobs.
const Matter = require('../models/Matter');
const User = require('../models/User');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { sendSMS } = require('../services/smsService');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TYPE_LABEL = {
  hearing: 'Hearing', filing_deadline: 'Filing deadline', limitation: 'Limitation date',
  meeting: 'Meeting', judgment: 'Judgment', other: 'Key date',
};

async function checkMatterReminders() {
  try {
    const now = Date.now();
    const matters = await Matter.find({
      status: { $ne: 'closed' },
      keyDates: { $elemMatch: { done: false, date: { $gte: new Date(now), $lte: new Date(now + 7 * DAY_MS) } } },
    });

    for (const matter of matters) {
      const due = [];
      for (const d of matter.keyDates) {
        if (d.done) continue;
        const ms = new Date(d.date).getTime() - now;
        if (ms < 0) continue;
        if (ms <= DAY_MS && !d.reminded1d) { due.push({ d, window: 'tomorrow' }); d.reminded1d = true; d.reminded7d = true; }
        else if (ms <= 7 * DAY_MS && !d.reminded7d) { due.push({ d, window: 'in the next 7 days' }); d.reminded7d = true; }
      }
      if (!due.length) continue;

      const ids = [matter.responsibleLawyer, ...(matter.team || [])].filter(Boolean);
      // eslint-disable-next-line no-await-in-loop
      const [users, company] = await Promise.all([
        User.find({ _id: { $in: ids }, companyId: matter.companyId }).select('name email phone'),
        Company.findById(matter.companyId).select('companyName logo smsSettings'),
      ]);
      const clientUrl = (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

      for (const { d, window } of due) {
        const when = new Date(d.date).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const label = TYPE_LABEL[d.type] || 'Key date';
        const subject = `${label} ${window}: ${matter.title} (${matter.matterNumber})`;
        const html = emailService.baseTemplate(subject, `
          <p style="color:#475569;line-height:1.7;"><strong>${esc(label)}:</strong> ${esc(d.title)}<br/>
          <strong>When:</strong> ${esc(when)}<br/>
          ${d.location ? `<strong>Where:</strong> ${esc(d.location)}<br/>` : ''}
          <strong>Matter:</strong> ${esc(matter.matterNumber)} — ${esc(matter.title)}<br/>
          <strong>Client:</strong> ${esc(matter.client?.name)}<br/>
          ${matter.court?.suitNumber ? `<strong>Suit No.:</strong> ${esc(matter.court.suitNumber)}<br/>` : ''}
          ${matter.court?.name ? `<strong>Court:</strong> ${esc(matter.court.name)}<br/>` : ''}</p>
          ${d.notes ? `<p style="color:#475569;line-height:1.7;">${esc(d.notes)}</p>` : ''}
          <p><a href="${clientUrl}/matters/${matter._id}" style="color:#6366f1;">Open the matter</a></p>`,
        { name: company?.companyName, logo: company?.logo });

        for (const u of users) {
          if (u.email) emailService.send({ to: u.email, subject, html }).catch((e) => logger.warn(`matter reminder email: ${e.message}`));
          if (window === 'tomorrow' && u.phone && company?.smsSettings?.enabled !== false) {
            sendSMS({ to: u.phone, message: `${label} tomorrow (${when}): ${d.title} — ${matter.matterNumber}${matter.court?.suitNumber ? `, ${matter.court.suitNumber}` : ''}. - BizlyAI` }).catch(() => {});
          }
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await matter.save();
    }
  } catch (err) {
    logger.error(`checkMatterReminders failed: ${err.message}`);
  }
}

module.exports = { checkMatterReminders };
