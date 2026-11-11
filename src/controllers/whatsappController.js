'use strict';

const Company = require('../models/Company');
const wa = require('../services/whatsappService');
const cloud = require('../services/whatsappCloud');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

const io = (req) => req.app.get('io');

const WEBHOOK_PATH = '/api/v1/webhooks/whatsapp';
const webhookUrl = (req) => `${(process.env.API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}${WEBHOOK_PATH}`;

// ── Official WhatsApp (Cloud API) ─────────────────────────────────────────
function cloudView(company, req) {
  const wc = company?.whatsappCloud || {};
  return {
    connected: Boolean(wc.connected),
    phoneNumberId: wc.phoneNumberId || null,
    wabaId: wc.wabaId || null,
    displayPhone: wc.displayPhone || null,
    verifiedName: wc.verifiedName || null,
    connectedAt: wc.connectedAt || null,
    // Connected by BizlyAI on its own account: the business never handles a token.
    managed: Boolean(wc.managed),
    // Token health: replies stop when Meta refuses the token.
    needsReconnect: Boolean(wc.connected && wc.needsReconnect),
    lastError: wc.needsReconnect ? wc.lastError || null : null,
    tokenExpiresAt: wc.tokenExpiresAt || null,
    // What the platform owner sets once in the Meta app (Webhooks).
    webhookUrl: webhookUrl(req),
    webhookReady: Boolean(process.env.WHATSAPP_VERIFY_TOKEN && process.env.META_APP_SECRET),
  };
}

exports.getStatus = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('whatsappCloud').lean();
    res.status(200).json({ success: true, data: { ...wa.getStatus(req.companyId), cloud: cloudView(company, req) } });
  } catch (err) { next(err); }
};

exports.connectCloud = async (req, res, next) => {
  try {
    const phoneNumberId = String(req.body.phoneNumberId || '').trim();
    const wabaId = String(req.body.wabaId || '').trim();
    const accessToken = String(req.body.accessToken || '').trim();
    if (!/^\d{6,25}$/.test(phoneNumberId)) return next(new AppError('Enter the Phone Number ID (digits only) from your Meta app.', 400));
    if (!/^\d{6,25}$/.test(wabaId)) return next(new AppError('Enter the WhatsApp Business Account ID (digits only) from your Meta app.', 400));
    if (accessToken.length < 20) return next(new AppError('Paste the access token from your Meta app.', 400));

    const taken = await Company.exists({ _id: { $ne: req.companyId }, 'whatsappCloud.phoneNumberId': phoneNumberId });
    if (taken) return next(new AppError('This WhatsApp number is already connected to another business on BizlyAI.', 409));

    let info;
    try {
      info = await cloud.verifyAndSubscribe({ phoneNumberId, wabaId, accessToken });
    } catch (err) {
      return next(new AppError(`Meta did not accept these details: ${err.message}`, 400));
    }
    // When does this token stop working? (null = never). Best effort.
    let tokenExpiresAt = null;
    try { tokenExpiresAt = (await cloud.tokenInfo(accessToken)).expiresAt; } catch { /* unknown */ }

    const company = await Company.findByIdAndUpdate(req.companyId, {
      $set: {
        'whatsappCloud.connected': true,
        'whatsappCloud.phoneNumberId': phoneNumberId,
        'whatsappCloud.wabaId': wabaId,
        'whatsappCloud.accessToken': accessToken,
        'whatsappCloud.displayPhone': info.displayPhone,
        'whatsappCloud.verifiedName': info.verifiedName,
        'whatsappCloud.connectedAt': new Date(),
        'whatsappCloud.tokenExpiresAt': tokenExpiresAt,
        'whatsappCloud.needsReconnect': false,
        'whatsappCloud.managed': false,
      },
      $unset: { 'whatsappCloud.lastError': 1, 'whatsappCloud.lastErrorAt': 1, 'whatsappCloud.alertedAt': 1 },
    }, { new: true }).select('whatsappCloud');
    cloud.forget(req.companyId);

    // One connection at a time: the official number replaces the QR session.
    await wa.disconnect(req.companyId).catch(() => {});

    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'whatsapp.cloud_connect', ip: req.ip, metadata: { phoneNumberId, displayPhone: info.displayPhone } });
    res.status(200).json({ success: true, data: cloudView(company, req), message: `Connected ${info.displayPhone || 'your WhatsApp number'}.` });
  } catch (err) { next(err); }
};

exports.disconnectCloud = async (req, res, next) => {
  try {
    const company = await Company.findByIdAndUpdate(req.companyId, {
      $set: { 'whatsappCloud.connected': false, 'whatsappCloud.needsReconnect': false, 'whatsappCloud.managed': false },
      $unset: { 'whatsappCloud.accessToken': 1, 'whatsappCloud.phoneNumberId': 1 },
    }, { new: true }).select('whatsappCloud');
    cloud.forget(req.companyId);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'whatsapp.cloud_disconnect', ip: req.ip });
    res.status(200).json({ success: true, data: cloudView(company, req), message: 'Official WhatsApp disconnected.' });
  } catch (err) { next(err); }
};

// ── QR-code session (whatsapp-web.js) ─────────────────────────────────────
exports.getQRCode = (req, res) => {
  const s = wa.getStatus(req.companyId);
  res.status(200).json({ success: true, data: { qr: s.qr || null, status: s.status } });
};

exports.initialize = async (req, res, next) => {
  try {
    if (await cloud.isConnected(req.companyId)) {
      return next(new AppError('Official WhatsApp is connected. Disconnect it first to use the QR code instead.', 400));
    }
    wa.setIo(io(req));
    const status = wa.initialize(req.companyId, io(req));
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'whatsapp.initialize', ip: req.ip });
    res.status(200).json({ success: true, data: status, message: 'WhatsApp starting — scan the QR code with your phone.' });
  } catch (err) { next(err); }
};

exports.disconnect = async (req, res, next) => {
  try {
    await wa.disconnect(req.companyId);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'whatsapp.disconnect', ip: req.ip });
    res.status(200).json({ success: true, message: 'WhatsApp disconnected.' });
  } catch (err) { next(err); }
};

// ── Test message ──────────────────────────────────────────────────────────
exports.sendTest = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return next(new AppError('Enter the WhatsApp phone number to send the test to, e.g. 0801 234 5678. The message text is fixed by Meta.', 400));
    }

    // A business can't start a WhatsApp chat with free text, so the official
    // test uses Meta's built-in "hello_world" template.
    const r = await cloud.isConnected(req.companyId)
      ? await cloud.sendTemplate(req.companyId, phone, 'hello_world', 'en_US')
      : await wa.sendToCustomer(req.companyId, phone, '✅ Test message from your BizlyAI WhatsApp assistant. The integration is working!');
    if (!r.success) return next(new AppError(r.reason || 'WhatsApp is not connected.', 400));
    res.status(200).json({ success: true, message: `Test message sent to ${phone}` });
  } catch (err) { next(err); }
};

// Conversations live in the shared inbox — see controllers/inboxController.js.
