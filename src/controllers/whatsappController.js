'use strict';

const wa = require('../services/whatsappService');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

const io = (req) => req.app.get('io');

// ── Client lifecycle ──────────────────────────────────────────────────────
exports.getStatus = (req, res) => {
  res.status(200).json({ success: true, data: wa.getStatus(req.companyId) });
};

exports.getQRCode = (req, res) => {
  const s = wa.getStatus(req.companyId);
  res.status(200).json({ success: true, data: { qr: s.qr || null, status: s.status } });
};

exports.initialize = (req, res, next) => {
  try {
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

exports.sendTest = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return next(new AppError('Phone number is required.', 400));
    const r = await wa.sendToCustomer(
      req.companyId, phone,
      '✅ Test message from your BizlyAI WhatsApp assistant. The integration is working!'
    );
    if (!r.success) return next(new AppError(r.reason || 'WhatsApp is not connected.', 400));
    res.status(200).json({ success: true, message: `Test message sent to ${phone}` });
  } catch (err) { next(err); }
};

// Conversations live in the shared inbox — see controllers/inboxController.js.
