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
function baseTemplate(title, content) {
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
          <td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 40px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px;">
              ⚡ EngrHenryTech BusinessAI
            </h1>
            <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:14px;">
              Powered by AI · Built for Business
            </p>
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
  sendBroadcast,
  send,
};