'use strict';

// HTTP side of the business assistant (services/assistant). A conversation
// belongs to one person; only they see it and only they can approve its
// actions. One request at a time per conversation, so a turn and an approval
// can't overwrite each other's changes.

const mongoose = require('mongoose');
const AssistantConversation = require('../models/AssistantConversation');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');
const { runTurn, decisionNote } = require('../services/assistant/agent');
const { TOOLS } = require('../services/assistant/tools');

const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const STUCK_MS = 10 * 60 * 1000;
const MAX_STORED_MESSAGES = 300;
const busy = new Set();

async function contextFor(req) {
  const company = await Company.findById(req.companyId)
    .select('companyName defaultCurrency logo profile paymentSettings smsSettings invoiceReminders');
  return {
    companyId: new mongoose.Types.ObjectId(String(req.companyId)),
    userId: req.user._id,
    userName: req.user.name,
    role: req.user.role,
    company,
  };
}

function actionView(a) {
  const age = Date.now() - new Date(a.createdAt);
  let { status, result } = a;
  if (status === 'pending' && age > ACTION_TTL_MS) status = 'expired';
  if (status === 'running' && Date.now() - new Date(a.decidedAt || a.createdAt) > STUCK_MS) {
    status = 'failed'; result = result || 'This was interrupted. Check the records before trying again.';
  }
  return { id: String(a._id), tool: a.tool, summary: a.summary, details: a.details, status, result, decidedAt: a.decidedAt };
}

function view(convo) {
  const actions = new Map(convo.actions.map((a) => [String(a._id), a]));
  const items = [];
  for (const m of convo.messages) {
    if (m.role === 'user' && !m.note) items.push({ type: 'user', text: m.content, at: m.at });
    else if (m.role === 'assistant' && m.content) items.push({ type: 'assistant', text: m.content, at: m.at, ...(m.error && { error: true }) });
    else if (m.role === 'tool' && m.actionId && actions.has(m.actionId)) items.push({ type: 'action', action: actionView(actions.get(m.actionId)) });
    else if (m.role === 'tool' && m.label) {
      const prev = items[items.length - 1];
      if (!(prev?.type === 'step' && prev.text === m.label)) items.push({ type: 'step', text: m.label });
    }
  }
  return { id: String(convo._id), title: convo.title, updatedAt: convo.updatedAt, items };
}

// Old turns drop off the front once a chat gets very long, cut on a user
// message so no tool result is left without its call.
function trimHistory(convo) {
  if (convo.messages.length <= MAX_STORED_MESSAGES) return;
  let start = convo.messages.length - MAX_STORED_MESSAGES;
  while (start < convo.messages.length && convo.messages[start]?.role !== 'user') start += 1;
  convo.messages = convo.messages.slice(start);
}

async function withLock(id, fn) {
  const key = String(id);
  if (busy.has(key)) throw new AppError('The assistant is still working on this chat. Give it a moment.', 409);
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

const scope = (req, id) => ({ _id: id, companyId: req.companyId, userId: req.user._id });
const validId = (id) => mongoose.isValidObjectId(id);

exports.listConversations = async (req, res, next) => {
  try {
    const rows = await AssistantConversation.find({ companyId: req.companyId, userId: req.user._id })
      .sort({ updatedAt: -1 }).limit(30).select('title updatedAt actions.status').lean();
    res.status(200).json({
      success: true,
      data: rows.map((c) => ({ id: String(c._id), title: c.title, updatedAt: c.updatedAt, pending: (c.actions || []).filter((a) => a.status === 'pending').length })),
    });
  } catch (err) { next(err); }
};

exports.getConversation = async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return next(new AppError('Chat not found.', 404));
    const convo = await AssistantConversation.findOne(scope(req, req.params.id));
    if (!convo) return next(new AppError('Chat not found.', 404));
    res.status(200).json({ success: true, data: view(convo) });
  } catch (err) { next(err); }
};

exports.deleteConversation = async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return next(new AppError('Chat not found.', 404));
    const gone = await AssistantConversation.findOneAndDelete(scope(req, req.params.id));
    if (!gone) return next(new AppError('Chat not found.', 404));
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
};

// POST /assistant/chat { message, conversationId? }
exports.chat = async (req, res, next) => {
  try {
    const text = String(req.body.message || '').trim();
    if (!text) return next(new AppError('Type a message.', 400));
    if (text.length > 4000) return next(new AppError('That message is too long. Keep it under 4,000 characters.', 400));

    let convo;
    if (req.body.conversationId) {
      if (!validId(req.body.conversationId)) return next(new AppError('Chat not found.', 404));
      convo = await AssistantConversation.findOne(scope(req, req.body.conversationId));
      if (!convo) return next(new AppError('Chat not found.', 404));
    } else {
      convo = new AssistantConversation({
        companyId: req.companyId, userId: req.user._id, title: text.replace(/\s+/g, ' ').slice(0, 80),
      });
    }

    await withLock(convo._id, async () => {
      const ctx = await contextFor(req);
      await runTurn(convo, ctx, text);
      trimHistory(convo);
      convo.markModified('messages');
      await convo.save();
    });
    Company.updateOne({ _id: req.companyId }, { $inc: { 'usage.agentExecutions': 1 } }).catch(() => {});
    res.status(200).json({ success: true, data: view(convo) });
  } catch (err) { next(err); }
};

// POST /assistant/conversations/:id/actions/:actionId/approve|reject
const decide = (decision) => async (req, res, next) => {
  try {
    const { id, actionId } = req.params;
    if (!validId(id) || !validId(actionId)) return next(new AppError('Action not found.', 404));

    const data = await withLock(id, async () => {
      const now = new Date();
      const convo = await AssistantConversation.findOneAndUpdate(
        { ...scope(req, id), actions: { $elemMatch: { _id: actionId, status: 'pending', createdAt: { $gte: new Date(now - ACTION_TTL_MS) } } } },
        { $set: { 'actions.$.status': decision === 'approve' ? 'running' : 'rejected', 'actions.$.decidedAt': now, 'actions.$.decidedBy': req.user._id } },
        { new: true },
      );
      if (!convo) {
        const existing = await AssistantConversation.findOne(scope(req, id)).select('actions');
        const action = existing?.actions.id(actionId);
        if (!action) throw new AppError('Action not found.', 404);
        if (action.status === 'pending') {
          await AssistantConversation.updateOne({ _id: id, 'actions._id': actionId }, { $set: { 'actions.$.status': 'expired' } });
          throw new AppError('This was prepared more than a day ago, so it has expired. Ask the assistant again for fresh details.', 410);
        }
        throw new AppError('This has already been handled.', 409);
      }

      const action = convo.actions.id(actionId);
      let status = 'rejected';
      let result;
      if (decision === 'approve') {
        const tool = TOOLS[action.tool];
        try {
          if (!tool || tool.kind !== 'action') throw new AppError('This action is no longer available.', 400);
          result = await tool.execute(action.args, await contextFor(req));
          status = 'done';
        } catch (e) {
          status = 'failed';
          result = e.isOperational ? e.message : 'Something went wrong while doing this.';
          if (!e.isOperational) logger.error(`Assistant action ${action.tool} failed: ${e.stack || e.message}`);
        }
        writeAuditLog({
          companyId: req.companyId, userId: req.user._id, action: `assistant.${action.tool}`, resource: 'AssistantConversation',
          resourceId: convo._id, description: `${action.summary} → ${status}: ${result}`.slice(0, 1000), ip: req.ip,
        });
      }
      action.status = status;
      action.result = result;
      await AssistantConversation.updateOne(
        { _id: id, 'actions._id': actionId },
        { $set: { 'actions.$.status': status, ...(result && { 'actions.$.result': result }) }, $push: { messages: decisionNote(action) } },
      );
      return view(await AssistantConversation.findById(id));
    });
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

exports.approveAction = decide('approve');
exports.rejectAction = decide('reject');
