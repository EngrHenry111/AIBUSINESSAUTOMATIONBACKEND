'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('../utils/logger');

let client = null;
let status = 'disconnected'; // disconnected | connecting | qr_ready | connected
let qrCode = null;
let qrCodeBase64 = null;

function getStatus() {
  return { status, qrCode: qrCodeBase64 };
}

function initialize(io) {
  if (client) return; // Already initialized

  logger.info('Initializing WhatsApp client...');
  status = 'connecting';

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'businessai-whatsapp' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  // QR Code generated — send to frontend via Socket.io
  client.on('qr', (qr) => {
    status = 'qr_ready';
    qrCode = qr;
    logger.info('WhatsApp QR code ready — scan with your phone');

    // Terminal QR for development
    qrcode.generate(qr, { small: true });

    // Convert to base64 for frontend display
    try {
      const QRCode = require('qrcode');
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
          qrCodeBase64 = url;
          if (io) io.emit('whatsapp:qr', { qr: url });
        }
      });
    } catch {
      // qrcode package not installed — terminal only
      if (io) io.emit('whatsapp:qr', { qr });
    }
  });

  client.on('ready', () => {
    status = 'connected';
    qrCode = null;
    qrCodeBase64 = null;
    logger.info('✅ WhatsApp client connected and ready');
    if (io) io.emit('whatsapp:status', { status: 'connected' });
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated successfully');
  });

  client.on('auth_failure', (msg) => {
    status = 'disconnected';
    logger.error('WhatsApp authentication failed:', msg);
    if (io) io.emit('whatsapp:status', { status: 'disconnected', error: 'Authentication failed' });
  });

  client.on('disconnected', (reason) => {
    status = 'disconnected';
    client = null;
    logger.warn('WhatsApp disconnected:', reason);
    if (io) io.emit('whatsapp:status', { status: 'disconnected' });
  });

  client.initialize().catch(err => {
    status = 'disconnected';
    logger.error('WhatsApp init failed:', err.message);
  });
}

// ── Format phone number for WhatsApp ────────────────────────────────────
function formatNumber(phone) {
  // Remove all non-digits
  let num = phone.replace(/\D/g, '');
  // Add country code if missing (default Nigeria +234)
  if (num.startsWith('0')) num = '234' + num.slice(1);
  if (!num.includes('@')) num = `${num}@c.us`;
  return num;
}

// ── Core send function ────────────────────────────────────────────────────
async function sendMessage(phone, message) {
  if (!client || status !== 'connected') {
    logger.warn(`WhatsApp not connected. Cannot send to ${phone}`);
    return { success: false, reason: 'WhatsApp not connected' };
  }

  try {
    const chatId = formatNumber(phone);
    await client.sendMessage(chatId, message);
    logger.info(`✅ WhatsApp sent to ${phone}`);
    return { success: true };
  } catch (err) {
    logger.error(`WhatsApp send failed to ${phone}: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ── Business message templates ────────────────────────────────────────────

async function sendAppointmentConfirmation(phone, data) {
  const msg = `✅ *Appointment Confirmed*

Hello ${data.customerName}! 👋

Your appointment has been confirmed:
📋 *${data.title}*
📅 *Date:* ${data.dateTime}
⏱ *Duration:* ${data.duration} minutes
${data.location ? `📍 *Location:* ${data.location}` : ''}
${data.meetingLink ? `🔗 *Meeting Link:* ${data.meetingLink}` : ''}

${data.notes ? `📝 *Notes:* ${data.notes}` : ''}

Please arrive on time. Reply to this message if you need to reschedule.

_Powered by EngrHenryTech BusinessAI_ ⚡`;

  return sendMessage(phone, msg);
}

async function sendAppointmentReminder(phone, data) {
  const msg = `⏰ *Appointment Reminder*

Hello ${data.customerName}!

This is a reminder about your upcoming appointment:
📋 *${data.title}*
📅 *Tomorrow at ${data.time}*
${data.location ? `📍 *Location:* ${data.location}` : ''}
${data.meetingLink ? `🔗 *Join here:* ${data.meetingLink}` : ''}

See you soon! 😊

_EngrHenryTech BusinessAI_ ⚡`;

  return sendMessage(phone, msg);
}

async function sendInvoiceReminder(phone, data) {
  const daysText = data.daysOverdue > 0
    ? `⚠️ This invoice is *${data.daysOverdue} days overdue*.`
    : `📅 This invoice is due on *${data.dueDate}*.`;

  const msg = `💳 *Payment Reminder*

Hello ${data.customerName},

${daysText}

📄 *Invoice:* ${data.invoiceNumber}
💰 *Amount Due:* ${data.currency} ${data.amount}
📅 *Due Date:* ${data.dueDate}

Please make payment at your earliest convenience to avoid service interruption.

For payment enquiries, reply to this message.

_EngrHenryTech BusinessAI_ ⚡`;

  return sendMessage(phone, msg);
}

async function sendOrderUpdate(phone, data) {
  const statusEmoji = {
    confirmed: '✅', processing: '⚙️', shipped: '🚚',
    delivered: '📦', cancelled: '❌',
  };

  const msg = `${statusEmoji[data.status] || '📦'} *Order Update*

Hello ${data.customerName}!

Your order status has been updated:
🔢 *Order:* ${data.orderNumber}
📊 *Status:* ${data.status.toUpperCase()}
${data.trackingNumber ? `🔍 *Tracking:* ${data.trackingNumber}` : ''}
${data.carrier ? `🚚 *Carrier:* ${data.carrier}` : ''}
${data.estimatedDelivery ? `📅 *Est. Delivery:* ${data.estimatedDelivery}` : ''}

${data.message || ''}

_EngrHenryTech BusinessAI_ ⚡`;

  return sendMessage(phone, msg);
}

async function sendTeamInvite(phone, data) {
  const msg = `🎉 *You're Invited!*

Hello ${data.name}!

*${data.inviterName}* has invited you to join *${data.companyName}* on EngrHenryTech BusinessAI.

📧 *Email:* ${data.email}
🔑 *Temporary Password:* \`${data.tempPassword}\`

👉 Login at: ${data.loginUrl}

Please change your password after your first login.

_EngrHenryTech BusinessAI_ ⚡`;

  return sendMessage(phone, msg);
}

async function sendWelcome(phone, data) {
  const msg = `🚀 *Welcome to EngrHenryTech BusinessAI!*

Hello ${data.name}! 👋

Your workspace *${data.companyName}* is ready.

Here's how to get started:
📄 Upload your company documents
💬 Ask AI questions about your business
👥 Invite your team members
📊 View your analytics dashboard

👉 *Platform:* ${data.platformUrl}

We're excited to have you on board!

_EngrHenryTech BusinessAI_ ⚡`;

  return sendMessage(phone, msg);
}

async function disconnect() {
  if (client) {
    await client.destroy();
    client = null;
    status = 'disconnected';
    logger.info('WhatsApp disconnected manually');
  }
}

module.exports = {
  initialize,
  getStatus,
  sendMessage,
  sendAppointmentConfirmation,
  sendAppointmentReminder,
  sendInvoiceReminder,
  sendOrderUpdate,
  sendTeamInvite,
  sendWelcome,
  disconnect,
};