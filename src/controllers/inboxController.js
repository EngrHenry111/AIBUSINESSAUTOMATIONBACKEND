'use strict';

/**
 * The shared customer inbox: every channel's conversations in one list,
 * with the customer's profile (other chats, lead, purchases) beside each.
 */
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Customer = require('../models/Customer');
const inbox = require('../services/inbox');
const escapeRegex = require('../utils/escapeRegex');
const { AppError } = require('../middleware/errorMiddleware');

const preview = (m) => {
  if (!m) return '';
  const prefix = m.from === 'ai' ? '🤖 ' : m.from === 'human' ? `${m.agentName || 'Team'}: ` : '';
  return `${prefix}${m.content}`.slice(0, 90);
};

function listItem(c) {
  const msgs = c.messages || [];
  const last = [...msgs].reverse().find((m) => m.from !== 'system') || msgs[msgs.length - 1];
  return {
    _id: c._id,
    channel: c.channel,
    displayName: c.displayName || c.email || (c.channel === 'widget' ? `Visitor #${String(c._id).slice(-4)}` : c.externalId),
    phone: c.phone || null,
    email: c.email || null,
    status: c.status,
    assignedTo: c.assignedTo || null,
    contactId: c.contactId || null,
    lastMessage: preview(last),
    lastMessageFrom: last?.from || null,
    lastMessageAt: c.lastMessageAt,
    unread: msgs.filter((m) => m.from === 'customer' && !m.read).length,
    handoverRequestedAt: c.handoverRequestedAt || null,
  };
}

async function loadOwn(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Conversation not found.', 404);
  const convo = await Conversation.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!convo) throw new AppError('Conversation not found.', 404);
  return convo;
}

// ── List ──────────────────────────────────────────────────────────────────
exports.getConversations = async (req, res, next) => {
  try {
    const { status = 'all', channel = 'all', search } = req.query;
    const q = { companyId: req.companyId };
    if (['ai', 'human', 'resolved'].includes(status)) q.status = status;
    else if (status === 'unclaimed') { q.status = 'human'; q.assignedTo = null; }
    else if (status === 'mine') q.assignedTo = req.user._id;
    if (Conversation.CHANNELS.includes(channel)) q.channel = channel;
    if (search?.trim()) {
      const rx = { $regex: escapeRegex(search.trim()), $options: 'i' };
      q.$or = [{ displayName: rx }, { phone: rx }, { email: rx }, { externalId: rx }];
    }

    const cid = new mongoose.Types.ObjectId(String(req.companyId));
    const [convos, byStatus, byChannel, unclaimed] = await Promise.all([
      Conversation.find(q)
        .select({ messages: { $slice: -40 }, channel: 1, displayName: 1, phone: 1, email: 1, status: 1, assignedTo: 1, contactId: 1, lastMessageAt: 1, handoverRequestedAt: 1, externalId: 1, sales: 1, followUp: 1 })
        .populate('assignedTo', 'name')
        .sort({ lastMessageAt: -1 })
        .limit(200)
        .lean(),
      Conversation.aggregate([{ $match: { companyId: cid } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Conversation.aggregate([{ $match: { companyId: cid } }, { $group: { _id: '$channel', n: { $sum: 1 } } }]),
      Conversation.countDocuments({ companyId: req.companyId, status: 'human', assignedTo: null }),
    ]);

    const s = Object.fromEntries(byStatus.map((x) => [x._id, x.n]));
    res.status(200).json({
      success: true,
      data: convos.map(listItem),
      counts: {
        all: Object.values(s).reduce((a, b) => a + b, 0),
        ai: s.ai || 0,
        human: s.human || 0,
        resolved: s.resolved || 0,
        unclaimed,
        channels: Object.fromEntries(byChannel.map((x) => [x._id, x.n])),
      },
    });
  } catch (err) { next(err); }
};

// Just the badge number for the sidebar — cheap enough to poll.
exports.getUnclaimedCount = async (req, res, next) => {
  try {
    const unclaimed = await Conversation.countDocuments({ companyId: req.companyId, status: 'human', assignedTo: null });
    res.status(200).json({ success: true, data: { unclaimed } });
  } catch (err) { next(err); }
};

// ── Customer profile beside a conversation ────────────────────────────────
async function profileFor(convo) {
  const contact = convo.contactId
    ? await Contact.findOne({ _id: convo.contactId, companyId: convo.companyId }).lean()
    : null;

  const [others, lead, customer] = await Promise.all([
    contact
      ? Conversation.find({ companyId: convo.companyId, contactId: contact._id, _id: { $ne: convo._id } })
        .select({ messages: { $slice: -1 }, channel: 1, status: 1, lastMessageAt: 1, displayName: 1 })
        .sort({ lastMessageAt: -1 }).limit(10).lean()
      : [],
    contact?.leadId
      ? Lead.findOne({ _id: contact.leadId, companyId: convo.companyId }).select('name status value score source nextFollowUpAt ai.priority interestedIn').lean()
      : null,
    contact?.customerId
      ? Customer.findOne({ _id: contact.customerId, companyId: convo.companyId }).select('name totalOrders totalSpent lastOrderAt tags').lean()
      : null,
  ]);

  return {
    contact: contact && {
      _id: contact._id,
      name: contact.name,
      email: contact.email || null,
      phone: contact.phone || null,
      channels: [...new Set(contact.handles.map((h) => h.channel))],
      firstSeenAt: contact.firstSeenAt,
      lastSeenAt: contact.lastSeenAt,
      notes: contact.notes || '',
    },
    lead: lead && {
      _id: lead._id, status: lead.status, value: lead.value, source: lead.source,
      nextFollowUpAt: lead.nextFollowUpAt || null, score: lead.score ?? null, priority: lead.ai?.priority || null,
    },
    customer: customer && {
      _id: customer._id, totalOrders: customer.totalOrders, totalSpent: customer.totalSpent,
      lastOrderAt: customer.lastOrderAt || null, tags: customer.tags || [],
    },
    otherConversations: others.map((o) => ({
      _id: o._id, channel: o.channel, status: o.status, lastMessageAt: o.lastMessageAt,
      lastMessage: preview(o.messages?.[0]),
    })),
  };
}

exports.getConversation = async (req, res, next) => {
  try {
    const convo = await loadOwn(req);

    let touched = false;
    convo.messages.forEach((m) => { if (m.from === 'customer' && !m.read) { m.read = true; touched = true; } });
    if (touched) await convo.save();

    await convo.populate('assignedTo', 'name');
    const profile = await profileFor(convo);
    res.status(200).json({ success: true, data: convo, profile });
  } catch (err) { next(err); }
};

// ── Staff actions ─────────────────────────────────────────────────────────
exports.reply = async (req, res, next) => {
  try {
    const text = String(req.body.message || '').trim();
    if (!text) return next(new AppError('Message is required.', 400));
    const convo = await loadOwn(req);
    if (convo.status !== 'human') return next(new AppError('Take over this conversation before replying.', 400));
    if (convo.assignedTo && String(convo.assignedTo) !== String(req.user._id)) {
      return next(new AppError('This conversation is assigned to another team member.', 403));
    }
    const result = await inbox.staffReply(convo, req.user, text.slice(0, 4000));
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
};

exports.takeover = async (req, res, next) => {
  try {
    const convo = await loadOwn(req);
    if (convo.status === 'human' && convo.assignedTo && String(convo.assignedTo) !== String(req.user._id)) {
      return next(new AppError('Already claimed by another team member.', 409));
    }
    if (convo.status === 'human' && String(convo.assignedTo || '') === String(req.user._id)) {
      await convo.populate('assignedTo', 'name');
      return res.status(200).json({ success: true, data: convo });
    }
    await inbox.takeOver(convo, req.user);
    await convo.populate('assignedTo', 'name');
    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

exports.resolve = async (req, res, next) => {
  try {
    const convo = await loadOwn(req);
    if (convo.status === 'resolved') return res.status(200).json({ success: true, data: convo });
    await inbox.resolve(convo, req.user);
    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

exports.backToAI = async (req, res, next) => {
  try {
    const convo = await loadOwn(req);
    if (convo.status === 'ai') return res.status(200).json({ success: true, data: convo });
    await inbox.backToAI(convo, req.user);
    res.status(200).json({ success: true, data: convo });
  } catch (err) { next(err); }
};

// ── Contact notes (shown beside every chat with this person) ──────────────
exports.updateContactNotes = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Contact not found.', 404));
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { notes: String(req.body.notes || '').slice(0, 5000) },
      { new: true },
    ).select('notes');
    if (!contact) return next(new AppError('Contact not found.', 404));
    res.status(200).json({ success: true, data: { notes: contact.notes } });
  } catch (err) { next(err); }
};
