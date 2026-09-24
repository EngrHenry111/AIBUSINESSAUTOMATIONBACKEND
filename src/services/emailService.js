'use strict';

// Render blocks outbound SMTP (port 587/465), which is what was surfacing as
// ETIMEDOUT on every send there even though the exact same code worked
// locally. Resend's HTTP API sidesteps that entirely — it's a plain HTTPS
// POST, which is never blocked the way raw SMTP ports are on most PaaS
// hosts. Nodemailer/SMTP is gone from this file; every send below goes
// straight to https://api.resend.com/emails.
const axios = require('axios');
const logger = require('../utils/logger');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || 'BizlyAI <noreply@bislyai.com>';
const BASE_URL = process.env.CLIENT_URL?.split(',')[0] || 'http://localhost:5174';

// ── Base HTML wrapper ─────────────────────────────────────────────────────
// `brand` lets a company-facing email (invoices, receipts) show that
// company's own logo/name in the header instead of the generic BizlyAI
// banner. Omit it (or pass nothing) and every other email is unaffected.
function baseTemplate(title, content, brand) {
  const headerInner = brand?.name
    ? `
            ${brand.logo ? `<img src="${brand.logo}" alt="${brand.name}" style="max-height:44px;max-width:200px;object-fit:contain;margin-bottom:10px;"/><br/>` : ''}
            <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">
              ${brand.name}
            </h1>
            <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px;">
              ${brand.tagline || 'Powered by BizlyAI'}
            </p>`
    : `
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px;">
              BizlyAI
            </h1>
            <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:14px;">
              Powered by AI · Built for Business
            </p>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 40px;text-align:center;">${headerInner}
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            ${content}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="color:#94a3b8;font-size:12px;margin:0;line-height:1.7;">
              © ${new Date().getFullYear()} BizlyAI by ENGRHENRY TECH | RC: 9823522<br/>
              29 Pack Road, Itu, Akwa Ibom State, Nigeria<br/>
              <a href="${BASE_URL}" style="color:#6366f1;text-decoration:none;">bislyai.com</a> |
              <a href="mailto:support@bislyai.com" style="color:#6366f1;text-decoration:none;"> support@bislyai.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Email Senders ─────────────────────────────────────────────────────────

async function sendPasswordReset(email, name, resetToken) {
  const resetUrl = `${BASE_URL}/reset-password/${resetToken}`;
  const html = baseTemplate('Reset Your Password', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Reset your password</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name || 'there'},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      We received a request to reset your BizlyAI password.
      Click the button below to reset it. This link expires in <strong>10 minutes</strong>.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${resetUrl}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Reset Password
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:24px 0 0;">
      If you did not request a password reset, please ignore this email — your password won't change.<br/>
      Or copy this link: <a href="${resetUrl}" style="color:#6366f1;">${resetUrl}</a>
    </p>
  `);

  return send({ to: email, subject: 'Reset your BizlyAI password', html });
}

// A link (reusing the same passwordResetToken mechanism as forgotPassword,
// just with a longer expiry — see userController.inviteMember) rather than a
// plaintext temporary password: nothing sensitive sits in an inbox, and the
// invitee picks their own password before ever logging in.
async function sendTeamInvite(email, name, inviterName, companyName, setupLink, role, isReminder = false) {
  const heading = isReminder ? "Don't forget — you're invited! ⏰" : "You're Invited! 🎉";
  const intro = isReminder
    ? `Just a reminder — <strong>${inviterName}</strong> invited you to join <strong>${companyName}</strong> on BizlyAI${role ? ` as ${role}` : ''}, and you haven't set up your account yet.`
    : `<strong>${inviterName}</strong> has invited you to join <strong>${companyName}</strong> on BizlyAI — the AI-powered business operations platform${role ? ` as ${role}` : ''}.`;

  const html = baseTemplate(isReminder ? 'Reminder: You\'ve Been Invited' : 'You\'ve Been Invited', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">${heading}</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">${intro}</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${setupLink}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Set Your Password &amp; Get Started
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">
      This link expires in 7 days. If it expires, ask ${inviterName} to resend your invite.<br/>
      Or copy this link: <a href="${setupLink}" style="color:#6366f1;">${setupLink}</a>
    </p>
  `);

  const subject = isReminder ? `Reminder: you're invited to ${companyName} on BizlyAI` : `You've been invited to ${companyName} on BizlyAI`;
  return send({ to: email, subject, html });
}

async function sendWelcome(email, name, companyName) {
  const html = baseTemplate('Welcome to BizlyAI', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Welcome aboard, ${name}! 🚀</h2>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      Your workspace <strong>${companyName}</strong> is ready on BizlyAI.
      Here's what you can do to get started:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${[
        ['📄', 'Upload Documents', 'Add your company documents to build your AI knowledge base'],
        ['💬', 'Ask AI Questions', 'Query your documents with natural language'],
        ['👥', 'Invite Your Team', 'Add team members from the Team page'],
        ['📊', 'View Analytics', 'See your business metrics in real time'],
      ].map(([icon, title, desc]) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:24px;padding-right:16px;vertical-align:top;">${icon}</td>
                <td>
                  <p style="color:#0f172a;font-weight:600;margin:0 0 2px;">${title}</p>
                  <p style="color:#64748b;font-size:13px;margin:0;">${desc}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `).join('')}
    </table>
    <div style="text-align:center;margin:32px 0;">
      <a href="${BASE_URL}/dashboard" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Go to Dashboard
      </a>
    </div>
  `);

  return send({ to: email, subject: 'Welcome to BizlyAI', html });
}

async function sendInvoiceReminder(email, customerName, invoiceNumber, amount, dueDate, reminderText) {
  const html = baseTemplate('Payment Reminder', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Payment Reminder</h2>
    <p style="color:#475569;margin:0 0 24px;">Dear ${customerName},</p>
    <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:12px;padding:20px;margin:0 0 24px;">
      <p style="color:#92400e;margin:0;font-weight:600;">Invoice ${invoiceNumber} — ${amount}</p>
      <p style="color:#92400e;margin:4px 0 0;font-size:13px;">Due: ${dueDate}</p>
    </div>
    <div style="color:#475569;line-height:1.8;white-space:pre-line;">${reminderText}</div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;">
      Sent via BizlyAI
    </p>
  `);

  return send({ to: email, subject: `Payment Reminder: Invoice ${invoiceNumber}`, html });
}

async function sendAppointmentConfirmation(email, customerName, title, dateTime, location, confirmationText) {
  const html = baseTemplate('Appointment Confirmed', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Appointment Confirmed ✅</h2>
    <p style="color:#475569;margin:0 0 24px;">Dear ${customerName},</p>
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:20px;margin:0 0 24px;">
      <p style="color:#166534;margin:0;font-weight:600;font-size:16px;">${title}</p>
      <p style="color:#166534;margin:6px 0 0;">📅 ${dateTime}</p>
      ${location ? `<p style="color:#166534;margin:4px 0 0;">📍 ${location}</p>` : ''}
    </div>
    <div style="color:#475569;line-height:1.8;white-space:pre-line;">${confirmationText}</div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;">Sent via BizlyAI</p>
  `);

  return send({ to: email, subject: `Appointment Confirmed: ${title}`, html });
}

async function sendMeetingInvite(email, name, meeting, organizerName) {
  const dt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  const dateStr = dt ? dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD';
  const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'TBD';
  const html = baseTemplate(`Meeting Scheduled: ${meeting.title}`, `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">You've Been Invited to a Meeting 📅</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name || 'there'},</p>
    <div style="background:#f0f4ff;border:1px solid #dbe3ff;border-radius:12px;padding:20px;margin:0 0 24px;">
      <p style="color:#0f172a;margin:0 0 10px;font-weight:700;font-size:17px;">${meeting.title}</p>
      <p style="color:#334155;margin:4px 0;">📅 Date: <strong>${dateStr}</strong></p>
      <p style="color:#334155;margin:4px 0;">🕒 Time: <strong>${timeStr}</strong></p>
      ${meeting.duration ? `<p style="color:#334155;margin:4px 0;">⏱️ Duration: <strong>${meeting.duration} minutes</strong></p>` : ''}
      <p style="color:#334155;margin:4px 0;">👤 Organizer: <strong>${organizerName || 'BizlyAI'}</strong></p>
      ${meeting.location ? `<p style="color:#334155;margin:4px 0;">📍 Location: <strong>${meeting.location}</strong></p>` : ''}
    </div>
    ${meeting.description ? `<p style="color:#475569;margin:0 0 8px;font-weight:600;">Agenda</p><p style="color:#475569;line-height:1.7;white-space:pre-line;margin:0 0 24px;">${meeting.description}</p>` : ''}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;margin:0;">This meeting was scheduled on BizlyAI.</p>
  `);
  return send({ to: email, subject: `Meeting Scheduled: ${meeting.title}`, html });
}

// Gift card delivery — deliberately its own festive header rather than the
// standard baseTemplate banner, since this email IS the gift, not a
// transactional receipt.
function sendGiftCardEmail({ to, recipientName, buyerName, message, code, amount, currency, storeName, storeLogo, storeUrl, expiresAt }) {
  const naira = (n) => `${currency || 'NGN'} ${Number(n || 0).toLocaleString()}`;
  const expiryStr = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
    <tr><td style="padding:36px 24px;">
      <div style="background:linear-gradient(135deg,#7c3aed,#d97706);border-radius:20px 20px 0 0;padding:32px 28px;text-align:center;">
        ${storeLogo ? `<img src="${storeLogo}" alt="${storeName}" style="height:40px;margin-bottom:10px;"/>` : ''}
        <h1 style="color:#fff;margin:0;font-size:24px;">You've received a gift card! 🎁</h1>
        <p style="color:#fde68a;margin:8px 0 0;font-size:14px;">From ${buyerName || 'a friend'} — sent via ${storeName || 'BizlyAI'}</p>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 20px 20px;padding:32px 28px;">
        <p style="color:#334155;font-size:15px;margin:0 0 18px;">Hi ${recipientName || 'there'},</p>
        ${message ? `<blockquote style="margin:0 0 22px;padding:14px 18px;background:#faf5ff;border-left:4px solid #a855f7;border-radius:8px;color:#581c87;font-style:italic;font-size:14px;">"${message}"</blockquote>` : ''}

        <div style="text-align:center;margin:0 0 24px;">
          <div style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Gift Card Value</div>
          <div style="font-size:36px;font-weight:800;color:#7c3aed;">${naira(amount)}</div>
        </div>

        <div style="text-align:center;margin:0 0 24px;">
          <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">Your gift card code</div>
          <div style="display:inline-block;font-family:'Courier New',monospace;font-size:20px;font-weight:700;letter-spacing:0.05em;color:#0f172a;background:#f1f5f9;border:2px dashed #cbd5e1;border-radius:12px;padding:14px 22px;">${code}</div>
        </div>

        <p style="color:#475569;font-size:13.5px;text-align:center;margin:0 0 6px;">Valid at <strong>${storeName || 'the store'}</strong></p>
        ${expiryStr ? `<p style="color:#94a3b8;font-size:12.5px;text-align:center;margin:0 0 24px;">Valid until ${expiryStr}</p>` : ''}

        ${storeUrl ? `<div style="text-align:center;margin:0 0 24px;"><a href="${storeUrl}" style="background:linear-gradient(135deg,#7c3aed,#d97706);color:#fff;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">Shop Now</a></div>` : ''}

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:8px 0 16px;"/>
        <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0;">Enter this code at checkout to redeem. Powered by BizlyAI.</p>
      </div>
    </td></tr>
  </table>
</body></html>`;

  return send({
    to,
    subject: `🎁 You've received a ${naira(amount)} gift card${storeName ? ` for ${storeName}` : ''}!`,
    html,
    text: `You've received a ${naira(amount)} gift card from ${buyerName || 'a friend'}, valid at ${storeName || 'the store'}. Code: ${code}${expiryStr ? `. Valid until ${expiryStr}.` : ''}`,
  });
}

// Google Calendar "add event" link — no ICS generation needed, works from any inbox.
function googleCalendarLink(meeting) {
  if (!meeting.scheduledAt) return null;
  const toUtcStamp = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const start = new Date(meeting.scheduledAt);
  const end = new Date(start.getTime() + (Number(meeting.duration) || 60) * 60000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: meeting.title || 'Meeting',
    dates: `${toUtcStamp(start)}/${toUtcStamp(end)}`,
    details: meeting.description || '',
    location: meeting.location || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function sendMeetingReminder(email, name, meeting, when) {
  // when: '24h' | '1h'
  const dt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  const dateStr = dt ? dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'TBD';
  const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
  const heading = when === '1h' ? `Starting Soon: ${meeting.title} in 1 hour` : `Reminder: ${meeting.title} is Tomorrow`;
  const line = when === '1h'
    ? `Your meeting <strong>${meeting.title}</strong> starts in 1 hour, at <strong>${timeStr}</strong>.`
    : `Your meeting <strong>${meeting.title}</strong> is scheduled for tomorrow at <strong>${timeStr}</strong>.`;
  const calLink = googleCalendarLink(meeting);
  const html = baseTemplate(heading, `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">${when === '1h' ? '⏰ Starting Soon' : '🔔 Meeting Reminder'}</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name || 'there'},</p>
    <p style="color:#334155;line-height:1.7;margin:0 0 24px;">${line}</p>
    ${meeting.location ? `<p style="color:#334155;margin:0 0 24px;">📍 ${meeting.location}</p>` : ''}
    ${meeting.description ? `<p style="color:#475569;margin:0 0 8px;font-weight:600;">Agenda</p><p style="color:#475569;line-height:1.7;white-space:pre-line;margin:0 0 24px;">${meeting.description}</p>` : ''}
    ${calLink ? `<div style="text-align:center;margin:28px 0;"><a href="${calLink}" style="background:#6366f1;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">Add to Calendar</a></div>` : ''}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;margin:0;">Sent via BizlyAI.</p>
  `);
  return send({
    to: email,
    subject: when === '1h'
      ? `Starting Soon: ${meeting.title} - starts in 1 hour`
      : `Reminder: ${meeting.title} - ${dateStr}`,
    html,
  });
}

async function sendBroadcast(email, name, subject, body) {
  const html = baseTemplate(subject, `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">${subject}</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name || 'there'},</p>
    <div style="color:#475569;line-height:1.8;white-space:pre-line;">${body}</div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;">
      You're receiving this because you own a workspace on BizlyAI.
    </p>
  `);

  return send({ to: email, subject, html });
}

async function sendPortalLink(email, companyName, link) {
  const html = baseTemplate('Your Secure Access Link', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Access Your Documents</h2>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      <strong>${companyName || 'Your provider'}</strong> has shared your invoices, orders and appointments with you.
      Click below to view your documents.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        View My Documents
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">
      This link expires in <strong>24 hours</strong>.<br/>
      If you did not request this, please ignore this email.<br/>
      Or paste this link: <a href="${link}" style="color:#6366f1;">${link}</a>
    </p>
  `);

  return send({ to: email, subject: `Your secure access link from ${companyName || 'your provider'}`, html });
}

async function sendSubscriptionWarning(email, name, planName, endDate) {
  const html = baseTemplate('Subscription Won\'t Renew', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Your subscription won't renew</h2>
    <p style="color:#475569;margin:0 0 20px;">Hi ${name || 'there'},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 20px;">
      Your <strong>${planName}</strong> subscription is set to <strong>not renew</strong> and will end on
      <strong>${endDate}</strong>. This usually means a card issue or a cancellation.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${BASE_URL}/billing" style="background:#6366f1;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Keep My Subscription
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">Update your card or re-subscribe from the billing page to avoid losing access.</p>
  `);
  return send({ to: email, subject: `Action needed: your ${planName} subscription won't renew`, html });
}

async function sendPaymentFailed(email, name, planName, amount) {
  const html = baseTemplate('Payment Failed', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">We couldn't process your payment</h2>
    <p style="color:#475569;margin:0 0 20px;">Hi ${name || 'there'},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 20px;">
      A recurring charge of <strong>${amount}</strong> for your <strong>${planName}</strong> plan failed.
      Paystack will retry automatically, but please check your card to avoid an interruption.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${BASE_URL}/billing" style="background:#6366f1;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Update Payment Method
      </a>
    </div>
  `);
  return send({ to: email, subject: `Payment failed for your ${planName} plan`, html });
}

async function sendVerificationEmail(email, name, link) {
  const html = baseTemplate('Verify your email', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Verify your email address</h2>
    <p style="color:#475569;margin:0 0 20px;">Welcome, ${name || 'there'}!</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      Please confirm this is your email so we can secure your BizlyAI account and
      send you important updates. This link expires in <strong>24 hours</strong>.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Verify Email Address
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">
      If you didn't create a BizlyAI account, you can ignore this email.<br/>
      Or paste this link: <a href="${link}" style="color:#6366f1;">${link}</a>
    </p>
  `);
  return send({ to: email, subject: 'Verify your BizlyAI email address', html });
}

// ── Core send function ───────────────────────────────────────────────────
// No silent bypass on a misconfigured key on purpose — that was the original
// bug that made emails vanish from the Resend dashboard with zero attempt
// logged. The one guard below only fires when RESEND_API_KEY is genuinely
// absent (local dev without it configured); any real failure past that
// point (bad key, unverified from-domain, Resend API error, network) is
// always thrown and logged with the real response body.
//
// logger.info is dropped outside development (see utils/logger.js — level
// is 'warn' in production), which would make every one of these send
// attempts invisible on Render. console.log always prints regardless of
// level, so the attempt/success lines use it deliberately — this is exactly
// the kind of visibility gap that made the SMTP timeout hard to diagnose
// from Render's logs in the first place.
async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY not set — email skipped');
    return null;
  }

  try {
    console.log(`Attempting to send email to: ${to} | Subject: ${subject} | From: ${FROM}`);

    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: FROM,
        to: Array.isArray(to) ? to : [to],
        reply_to: 'support@bislyai.com',
        subject,
        html,
        text: text || html?.replace(/<[^>]*>/g, ''),
        // Reduces spam-folder odds: a stable-per-message reference ID plus a
        // real unsubscribe path are things inbox providers (Gmail, Outlook,
        // Yahoo) explicitly check for on bulk/transactional senders.
        headers: {
          'X-Entity-Ref-ID': new Date().getTime().toString(),
          'List-Unsubscribe': '<mailto:unsubscribe@bislyai.com>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log(`✅ Email sent to ${to} | ID: ${response.data.id}`);
    return response.data;
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    console.log(`❌ Email failed to ${to}: ${errorMsg}`);
    logger.error(`Email failed to ${to}: ${errorMsg}`);
    logger.error(`Error code: ${err.code}`);
    throw err;
  }
}

// Back-compat alias — every template function above (and a few
// controllers) call `send(...)`; keep it working, backed by the same
// real implementation as sendEmail.
const send = sendEmail;

module.exports = {
  sendEmail,
  sendPasswordReset,
  sendTeamInvite,
  sendWelcome,
  sendInvoiceReminder,
  sendAppointmentConfirmation,
  sendMeetingInvite,
  sendMeetingReminder,
  sendBroadcast,
  sendPortalLink,
  sendSubscriptionWarning,
  sendPaymentFailed,
  sendVerificationEmail,
  sendGiftCardEmail,
  baseTemplate,
  send,
};