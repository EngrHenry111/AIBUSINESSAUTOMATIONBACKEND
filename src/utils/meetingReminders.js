'use strict';

// Polls for meetings starting soon and emails every attendee once per
// threshold. Runs on an interval from server.js (no extra cron dependency —
// same pattern as utils/subscriptionChecker.js).
const Meeting = require('../models/Meeting');
const User = require('../models/User');
const emailService = require('../services/emailService');
const logger = require('./logger');

async function attendeeList(meeting) {
  const users = meeting.participants?.length
    ? await User.find({ _id: { $in: meeting.participants } }).select('name email')
    : [];
  const external = (meeting.externalParticipants || []).filter((p) => p.email);
  return [
    ...users.map((u) => ({ name: u.name, email: u.email })),
    ...external.map((p) => ({ name: p.name, email: p.email })),
  ];
}

async function sendReminderBatch(meetings, when) {
  for (const meeting of meetings) {
    // eslint-disable-next-line no-await-in-loop
    const attendees = await attendeeList(meeting);
    for (const a of attendees) {
      // eslint-disable-next-line no-await-in-loop
      await emailService.sendMeetingReminder(a.email, a.name, meeting, when)
        .catch((e) => logger.warn(`Meeting reminder (${when}) to ${a.email} failed: ${e.message}`));
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
