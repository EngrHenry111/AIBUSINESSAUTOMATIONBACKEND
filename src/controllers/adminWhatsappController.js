'use strict';

/**
 * Super admin: connect clients' WhatsApp numbers from BizlyAI's own WhatsApp
 * Business Account, so a business gets official WhatsApp without touching
 * Meta's developer tools.
 *
 * Setup (Render env):
 *   WHATSAPP_PLATFORM_TOKEN   — System User token (Never expire) with
 *                               whatsapp_business_messaging + _management
 *   WHATSAPP_PLATFORM_WABA_ID — the WhatsApp Business Account the numbers are on
 *
 * The admin adds the client's number in Meta's WhatsApp Manager, then picks
 * it here and assigns it to the client's workspace. The token never leaves
 * the server and is not stored on the company (managed: true).
 */
const mongoose = require('mongoose');
const Company = require('../models/Company');
const wa = require('../services/whatsappService');
const cloud = require('../services/whatsappCloud');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');

const emit = (companyId, payload) => {
  try { global.io?.to(`company:${companyId}`).emit('whatsapp:token_status', payload); } catch { /* live update only */ }
};

/** Platform setup + every number on the account, with the business it serves. */
exports.overview = async (req, res, next) => {
  try {
    const { token, wabaId } = cloud.platform();
    const setup = {
      tokenSet: Boolean(token),
      wabaSet: Boolean(wabaId),
      wabaId: wabaId || null,
      webhookReady: Boolean(process.env.WHATSAPP_VERIFY_TOKEN && process.env.META_APP_SECRET),
      tokenExpiresAt: null,
      tokenValid: null,
      error: null,
    };
    const connected = await Company.find({ 'whatsappCloud.connected': true })
      .select('companyName storeSlug whatsappCloud.phoneNumberId whatsappCloud.managed whatsappCloud.displayPhone whatsappCloud.needsReconnect whatsappCloud.connectedAt')
      .lean();
    const byNumber = new Map(connected.map((c) => [String(c.whatsappCloud.phoneNumberId), c]));

    let numbers = [];
    if (token && wabaId) {
      try {
        const info = await cloud.tokenInfo(token);
        setup.tokenValid = info.valid;
        setup.tokenExpiresAt = info.expiresAt;
      } catch (err) { setup.tokenValid = err.code === 190 ? false : null; setup.error = err.message; }
      try {
        numbers = await cloud.platformNumbers();
      } catch (err) { setup.error = `Meta: ${err.message}`; }
    }

    const view = (c) => (c ? {
      _id: c._id, companyName: c.companyName, managed: Boolean(c.whatsappCloud.managed),
      needsReconnect: Boolean(c.whatsappCloud.needsReconnect), connectedAt: c.whatsappCloud.connectedAt || null,
    } : null);

    res.status(200).json({
      success: true,
      data: {
        setup,
        numbers: numbers.map((n) => ({ ...n, company: view(byNumber.get(n.id)) })),
        // Businesses that connected their own Meta app (for the full picture).
        selfConnected: connected.filter((c) => !c.whatsappCloud.managed).map((c) => ({
          ...view(c), displayPhone: c.whatsappCloud.displayPhone || '', phoneNumberId: c.whatsappCloud.phoneNumberId,
        })),
      },
    });
  } catch (err) { next(err); }
};

/** Assign a platform number to a business. */
exports.connect = async (req, res, next) => {
  try {
    const companyId = String(req.body.companyId || '');
    const phoneNumberId = String(req.body.phoneNumberId || '').trim();
    if (!mongoose.isValidObjectId(companyId)) return next(new AppError('Choose a business.', 400));
    if (!/^\d{6,25}$/.test(phoneNumberId)) return next(new AppError('Choose a number.', 400));

    const { token, wabaId } = cloud.platform();
    if (!token || !wabaId) return next(new AppError('Set WHATSAPP_PLATFORM_TOKEN and WHATSAPP_PLATFORM_WABA_ID on Render first.', 400));

    const company = await Company.findById(companyId).select('companyName owner whatsappCloud.connected whatsappCloud.managed whatsappCloud.phoneNumberId').lean();
    if (!company) return next(new AppError('Business not found.', 404));

    const taken = await Company.findOne({ _id: { $ne: companyId }, 'whatsappCloud.phoneNumberId': phoneNumberId }).select('companyName').lean();
    if (taken) return next(new AppError(`This number is already connected to ${taken.companyName}. Disconnect it there first.`, 409));

    // Only numbers on our own account — the platform token must not be
    // pointed at someone else's number.
    let numbers;
    try { numbers = await cloud.platformNumbers(); } catch (err) { return next(new AppError(`Meta: ${err.message}`, 400)); }
    const number = numbers.find((n) => n.id === phoneNumberId);
    if (!number) return next(new AppError('That number is not on the BizlyAI WhatsApp account.', 400));

    let info;
    try {
      info = await cloud.verifyAndSubscribe({ phoneNumberId, wabaId, accessToken: token });
    } catch (err) { return next(new AppError(`Meta did not accept this: ${err.message}`, 400)); }
    let tokenExpiresAt = null;
    try { tokenExpiresAt = (await cloud.tokenInfo(token)).expiresAt; } catch { /* unknown */ }

    const replaced = company.whatsappCloud?.connected && company.whatsappCloud.phoneNumberId !== phoneNumberId
      ? company.whatsappCloud.phoneNumberId : null;

    await Company.updateOne({ _id: companyId }, {
      $set: {
        'whatsappCloud.connected': true,
        'whatsappCloud.managed': true,
        'whatsappCloud.phoneNumberId': phoneNumberId,
        'whatsappCloud.wabaId': wabaId,
        'whatsappCloud.displayPhone': info.displayPhone || number.displayPhone,
        'whatsappCloud.verifiedName': info.verifiedName || number.verifiedName,
        'whatsappCloud.connectedAt': new Date(),
        'whatsappCloud.tokenExpiresAt': tokenExpiresAt,
        'whatsappCloud.needsReconnect': false,
      },
      // Their own token (if any) is no longer used.
      $unset: { 'whatsappCloud.accessToken': 1, 'whatsappCloud.lastError': 1, 'whatsappCloud.lastErrorAt': 1, 'whatsappCloud.alertedAt': 1 },
    });
    cloud.forget(companyId);
    await wa.disconnect(companyId).catch(() => {}); // the official number replaces a QR session
    emit(companyId, { connected: true });

    writeAuditLog({ companyId, userId: req.user._id, action: 'whatsapp.cloud_connect', ip: req.ip, metadata: { phoneNumberId, displayPhone: info.displayPhone, by: 'platform_admin', replaced } });
    logger.warn(`WhatsApp: admin connected ${info.displayPhone || phoneNumberId} to ${company.companyName}`);
    res.status(200).json({ success: true, message: `${info.displayPhone || 'Number'} is now connected to ${company.companyName}.` });
  } catch (err) { next(err); }
};

/** Take a platform number away from a business (the number stays on our account). */
exports.disconnect = async (req, res, next) => {
  try {
    const companyId = String(req.body.companyId || '');
    if (!mongoose.isValidObjectId(companyId)) return next(new AppError('Choose a business.', 400));
    const company = await Company.findById(companyId).select('companyName whatsappCloud.managed whatsappCloud.connected').lean();
    if (!company) return next(new AppError('Business not found.', 404));
    if (!company.whatsappCloud?.managed) return next(new AppError('This business connected its own WhatsApp; they disconnect it from their WhatsApp page.', 400));

    await Company.updateOne({ _id: companyId }, {
      $set: { 'whatsappCloud.connected': false, 'whatsappCloud.managed': false, 'whatsappCloud.needsReconnect': false },
      $unset: { 'whatsappCloud.phoneNumberId': 1, 'whatsappCloud.accessToken': 1 },
    });
    cloud.forget(companyId);
    emit(companyId, { connected: false });
    writeAuditLog({ companyId, userId: req.user._id, action: 'whatsapp.cloud_disconnect', ip: req.ip, metadata: { by: 'platform_admin' } });
    res.status(200).json({ success: true, message: `WhatsApp disconnected from ${company.companyName}.` });
  } catch (err) { next(err); }
};
