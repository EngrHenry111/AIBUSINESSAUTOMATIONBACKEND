'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 587,
      secure: false,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY || process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
}

const FROM = process.env.EMAIL_FROM || 'BizlyAI <onboarding@resend.dev>';
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
              ⚡ EngrHenryTech BusinessAI
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
            <p style="color:#94a3b8;font-size:12px;margin:0;">
              © ${new Date().getFullYear()} EngrHenryTech BusinessAI · All rights reserved<br/>
              <a href="${BASE_URL}" style="color:#6366f1;text-decoration:none;">Visit Platform</a>
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
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Reset Your Password</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name || 'there'},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      We received a request to reset your password for your EngrHenryTech BusinessAI account.
      Click the button below to set a new password. This link expires in <strong>10 minutes</strong>.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${resetUrl}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Reset Password
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:24px 0 0;">
      If you didn't request this, ignore this email — your password won't change.<br/>
      Or copy this link: <a href="${resetUrl}" style="color:#6366f1;">${resetUrl}</a>
    </p>
  `);

  return send({ to: email, subject: 'Reset your EngrHenryTech BusinessAI password', html });
}

async function sendTeamInvite(email, name, inviterName, companyName, tempPassword) {
  const html = baseTemplate('You\'ve Been Invited', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">You're Invited! 🎉</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name},</p>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      <strong>${inviterName}</strong> has invited you to join <strong>${companyName}</strong> on 
      EngrHenryTech BusinessAI — the AI-powered business operations platform.
    </p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin:24px 0;">
      <p style="color:#475569;margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Your Login Details</p>
      <p style="color:#0f172a;margin:4px 0;"><strong>Email:</strong> ${email}</p>
      <p style="color:#0f172a;margin:4px 0;"><strong>Temporary Password:</strong> 
        <code style="background:#e2e8f0;padding:2px 8px;border-radius:4px;font-size:14px;">${tempPassword}</code>
      </p>
    </div>
    <div style="text-align:center;margin:32px 0;">
      <a href="${BASE_URL}/login" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Log In Now
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">
      Please change your password after your first login in Settings → Password.
    </p>
  `);

  return send({ to: email, subject: `You've been invited to ${companyName} on EngrHenryTech BusinessAI`, html });
}

async function sendWelcome(email, name, companyName) {
  const html = baseTemplate('Welcome to EngrHenryTech BusinessAI', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Welcome aboard, ${name}! 🚀</h2>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      Your workspace <strong>${companyName}</strong> is ready on EngrHenryTech BusinessAI.
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

  return send({ to: email, subject: `Welcome to EngrHenryTech BusinessAI, ${name}!`, html });
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
      Sent via EngrHenryTech BusinessAI
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
    <p style="color:#94a3b8;font-size:12px;">Sent via EngrHenryTech BusinessAI</p>
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

async function sendMeetingReminder(email, name, meeting, when) {
  // when: '24h' | '1h'
  const dt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
  const heading = when === '1h' ? `Starting Soon: ${meeting.title} in 1 hour` : `Reminder: ${meeting.title} is Tomorrow`;
  const line = when === '1h'
    ? `Your meeting <strong>${meeting.title}</strong> starts in 1 hour, at <strong>${timeStr}</strong>.`
    : `Your meeting <strong>${meeting.title}</strong> is scheduled for tomorrow at <strong>${timeStr}</strong>.`;
  const html = baseTemplate(heading, `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">${when === '1h' ? '⏰ Starting Soon' : '🔔 Meeting Reminder'}</h2>
    <p style="color:#475569;margin:0 0 24px;">Hi ${name || 'there'},</p>
    <p style="color:#334155;line-height:1.7;margin:0 0 24px;">${line}</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"/>
    <p style="color:#94a3b8;font-size:12px;margin:0;">Sent via BizlyAI.</p>
  `);
  return send({
    to: email,
    subject: when === '1h' ? `Starting Soon: ${meeting.title} in 1 hour` : `Reminder: ${meeting.title} is tomorrow`,
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
      You're receiving this because you own a workspace on EngrHenryTech BusinessAI.
    </p>
  `);

  return send({ to: email, subject, html });
}

async function sendPortalLink(email, companyName, link) {
  const html = baseTemplate('Your Documents', `
    <h2 style="color:#0f172a;margin:0 0 8px;font-size:22px;">Access Your Documents</h2>
    <p style="color:#475569;line-height:1.7;margin:0 0 24px;">
      ${companyName || 'Your provider'} has shared your invoices, orders and appointments with you.
      Click below to view them — the link works for <strong>24 hours</strong>.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="background:#6366f1;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        View My Documents
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">
      If you didn't request this, you can ignore this email.<br/>
      Or paste this link: <a href="${link}" style="color:#6366f1;">${link}</a>
    </p>
  `);

  return send({ to: email, subject: `Access your documents from ${companyName || 'your provider'}`, html });
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
        Verify Email
      </a>
    </div>
    <p style="color:#94a3b8;font-size:13px;margin:0;">
      If you didn't create a BizlyAI account, you can ignore this email.<br/>
      Or paste this link: <a href="${link}" style="color:#6366f1;">${link}</a>
    </p>
  `);
  return send({ to: email, subject: 'Verify your BizlyAI email address', html });
}

// ── Core send function ─────────────────────────────────────────────────────
async function send({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY && !process.env.EMAIL_PASS) {
    logger.warn(`Email not configured (set RESEND_API_KEY). Would send to ${to}: ${subject}`);
    return { messageId: 'not-configured', preview: `Email to ${to}: ${subject}` };
  }

  try {
    const info = await getTransporter().sendMail({ from: FROM, to, subject, html, text });
    logger.info(`Email sent to ${to}: ${subject} [${info.messageId}]`);
    return info;
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = {
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
  baseTemplate,
  send,
};