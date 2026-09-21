'use strict';

// Polls for meetings starting soon and emails every attendee once per
// threshold. Runs on an interval from server.js (no extra cron dependency —
// same pattern as utils/subscriptionChecker.js).
const Meeting = require('../models/Meeting');
const User = require('../models/User');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const { sendSMS } = require('../services/smsService');
const logger = require('./logger');

async function attendeeList(meeting) {
  // Internal participants are real Users, who may have a personal phone
  // (User.phone). externalParticipants currently has no UI to capture a
  // phone number, so `p.phone` is always undefined for them today — carried
  // through anyway so SMS starts working the moment that field is ever
  // populated (API or a future UI), with no further change needed here.
  const users = meeting.participants?.length
    ? await User.find({ _id: { $in: meeting.participants } }).select('name email phone')
    : [];
  const external = (meeting.externalParticipants || []).filter((p) => p.email || p.phone);
  return [
    ...users.map((u) => ({ name: u.name, email: u.email, phone: u.phone })),
    ...external.map((p) => ({ name: p.name, email: p.email, phone: p.phone })),
  ];
}

async function sendReminderBatch(meetings, when) {
  for (const meeting of meetings) {
    // eslint-disable-next-line no-await-in-loop
    const attendees = await attendeeList(meeting);
    // eslint-disable-next-line no-await-in-loop
    const company = await Company.findById(meeting.companyId).select('smsSettings');
    const smsOk = company?.smsSettings?.enabled !== false;

    for (const a of attendees) {
      if (a.email) {
        // eslint-disable-next-line no-await-in-loop
        await emailService.sendMeetingReminder(a.email, a.name, meeting, when)
          .catch((e) => logger.warn(`Meeting reminder (${when}) to ${a.email} failed: ${e.message}`));
      }
      if (a.phone && smsOk) {
        const whenLabel = when === '24h' ? 'tomorrow' : 'in 1 hour';
        // eslint-disable-next-line no-await-in-loop
        await sendSMS({
          to: a.phone,
          message: `Hi ${a.name}, reminder: "${meeting.title}" starts ${whenLabel} (${new Date(meeting.scheduledAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}). - BizlyAI`,
        }).catch(() => {});
      }
    }
    if (when === '24h') meeting.reminders.sent24h = true;
    else meeting.reminders.sent1h = true;
    // eslint-disable-next-line no-await-in-loop
    await meeting.save();
    logger.info(`📧 Sent ${when} reminder for meeting "${meeting.title}" (${attendees.length} attendee(s))`);
  }
}

async function checkMeetingReminders() {
  try {
    const now = new Date();
    const in1h = new Date(now.getTime() + 60 * 60 * 1000);
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const [due24h, due1h] = await Promise.all([
      Meeting.find({
        status: 'scheduled',
        scheduledAt: { $gt: in1h, $lte: in24h },
        'reminders.sent24h': false,
      }),
      Meeting.find({
        status: 'scheduled',
        scheduledAt: { $gt: now, $lte: in1h },
        'reminders.sent1h': false,
      }),
    ]);

    if (due24h.length) await sendReminderBatch(due24h, '24h');
    if (due1h.length) await sendReminderBatch(due1h, '1h');
  } catch (err) {
    logger.error(`checkMeetingReminders failed: ${err.message}`);
  }
}

module.exports = { checkMeetingReminders };
