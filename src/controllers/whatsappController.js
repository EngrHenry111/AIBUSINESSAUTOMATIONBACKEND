'use strict';

const WhatsAppConversation = require('../models/WhatsAppConversation');
const wa = require('../services/whatsappService');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');

const io = (req) => req.app.get('io');

function listItem(c) {
  const msgs = c.messages || [];
  const last = msgs[msgs.length - 1];
  return {
    _id: c._id,
    customerName: c.customerName || c.customerPhone,
    customerPhone: c.customerPhone,
    status: c.status,
    assignedTo: c.assignedTo || null,
    lastMessage: last ? `${last.from === 'customer' ? '' : last.from === 'ai' ? '🤖 ' : ''}${last.content}`.slice(0, 90) : '',
    lastMessageFrom: last?.from || null,
    lastMessageAt: c.lastMessageAt,
    unread: msgs.filter((m) => m.from === 'customer' && !m.read).length,
    handoverRequestedAt: c.handoverRequestedAt || null,
  };
}

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

// ── Conversations ─────────────────────────────────────────────────────────
exports.getConversations = async (req, res, next) => {
  try {
    const { filter = 'all', search } = req.query;
    const q = { companyId: req.companyId };
    if (filter === 'ai') q.status = { $in: ['ai', 'active'] };
    else if (filter === 'human') q.status = 'human_takeover';
    else if (filter === 'resolved') q.status = 'resolved';
    if (search && search.trim()) {
      const rx = { $regex: search.trim(), $options: 'i' };
      q.$or = [{ customerName: rx }, { customerPhone: rx }];
    }

    const [convos, byStatus, unclaimed] = await Promise.all([
      WhatsAppConversation.find(q).populate('assignedTo', 'name').sort({ lastMessageAt: -1 }).limit(200).lean(),
      WhatsAppConversation.aggregate([
        { $match: { companyId: req.companyId } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
      WhatsAppConversation.countDocuments({ companyId: req.companyId, status: 'human_takeover', assignedTo: null }),
    ]);

    const s = byStatus.reduce((a, x) => { a[x._id] = x.n; return a; }, {});
    res.status(200).json({
      success: true,
      data: convos.map(listItem),
      counts: {
        all: Object.values(s).reduce((a, b) => a + b, 0),
        ai: (s.ai || 0) + (s.active || 0),
        human: s.human_takeover || 0,
        resolved: s.resolved || 0,
        unclaimed,
      },
    });
  } catch (err) { next(err); }
};

exports.getConversation = async (req, res, next) => {
  try {
    const convo = await WhatsAppConversation.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('assignedTo', 'name');
    if (!convo) return next(new AppError('Conversation not found.', 404));

    let touched = false;
    convo.messages.forEach((m) => { if (m.from === 'customer' && !m.read) { m.read = true; touched = true; } });
    if (touched) await convo.save();

    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

// ── Human sends a message ─────────────────────────────────────────────────
exports.sendMessage = async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return next(new AppError('Message is required.', 400));

    const convo = await WhatsAppConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));
    if (convo.status !== 'human_takeover') {
      return next(new AppError('Take over this conversation before replying.', 400));
    }
    if (convo.assignedTo && String(convo.assignedTo) !== String(req.user._id)) {
      return next(new AppError('This conversation is assigned to another agent.', 403));
    }
    if (!convo.assignedTo) convo.assignedTo = req.user._id;

    const result = await wa.sendToCustomer(req.companyId, convo.customerPhone, message.trim());

    const entry = { from: 'human', content: message.trim(), timestamp: new Date(), agentName: req.user.name, read: true };
    convo.messages.push(entry);
    convo.lastMessageAt = new Date();
    await convo.save();

    io(req)?.to(`company:${req.companyId}`).emit('whatsapp:new_message', {
      conversationId: convo._id, message: convo.messages[convo.messages.length - 1], status: convo.status,
    });

    res.status(200).json({
      success: true,
      data: { message: convo.messages[convo.messages.length - 1], delivered: result.success, reason: result.reason },
    });
  } catch (err) { next(err); }
};

// ── Claim a conversation ──────────────────────────────────────────────────
exports.takeoverConversation = async (req, res, next) => {
  try {
    const convo = await WhatsAppConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));
    if (convo.assignedTo && String(convo.assignedTo) !== String(req.user._id)) {
      return next(new AppError('Already claimed by another agent.', 409));
    }

    convo.status = 'human_takeover';
    convo.assignedTo = req.user._id;
    if (!convo.handoverRequestedAt) convo.handoverRequestedAt = new Date();
    convo.messages.push({ from: 'system', content: `${req.user.name} joined the conversation`, timestamp: new Date(), read: true });
    convo.lastMessageAt = new Date();
    await convo.save();

    await wa.sendToCustomer(
      req.companyId, convo.customerPhone,
      `You're now chatting with ${req.user.name} from our team. How can we help?`
    );

    io(req)?.to(`company:${req.companyId}`).emit('whatsapp:conversation_claimed', {
      conversationId: convo._id, agent: { _id: req.user._id, name: req.user.name },
    });

    const populated = await convo.populate('assignedTo', 'name');
    res.status(200).json({ success: true, data: populated });
  } catch (err) { next(err); }
};

// ── Resolve ───────────────────────────────────────────────────────────────
exports.resolveConversation = async (req, res, next) => {
  try {
    const convo = await WhatsAppConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));

    convo.status = 'resolved';
    convo.resolvedAt = new Date();
    convo.assignedTo = null;
    convo.messages.push({ from: 'system', content: 'Conversation resolved', timestamp: new Date(), read: true });
    convo.lastMessageAt = new Date();
    await convo.save();

    await wa.sendToCustomer(
      req.companyId, convo.customerPhone,
      'This conversation has been marked as resolved. Message us anytime you need more help! 👋'
    );

    io(req)?.to(`company:${req.companyId}`).emit('whatsapp:conversation_updated', {
      conversationId: convo._id, status: 'resolved',
    });

    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

// ── Hand back to the AI ───────────────────────────────────────────────────
exports.sendToAI = async (req, res, next) => {
  try {
    const convo = await WhatsAppConversation.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!convo) return next(new AppError('Conversation not found.', 404));

    convo.status = 'ai';
    convo.assignedTo = null;
    convo.handoverRequestedAt = null;
    convo.resolvedAt = null;
    convo.messages.push({ from: 'system', content: 'Conversation handed back to the AI assistant', timestamp: new Date(), read: true });
    convo.lastMessageAt = new Date();
    await convo.save();

    await wa.sendToCustomer(
      req.companyId, convo.customerPhone,
      "You're back with our AI assistant — ask away and we'll help right now."
    );

    io(req)?.to(`company:${req.companyId}`).emit('whatsapp:conversation_updated', {
      conversationId: convo._id, status: 'ai',
    });

    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};
