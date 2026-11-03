'use strict';

// The business assistant's loop: the model plans, calls tools, reads their
// results and keeps going until it has an answer (at most MAX_STEPS model
// calls per message). Read tools run on the spot; action tools only leave a
// pending card on the conversation — see tools.js and the approve route.

const { complete } = require('../groqService');
const { MODELS } = require('../../config/groq');
const { cleanAIText } = require('../../utils/cleanAIText');
const logger = require('../../utils/logger');
const { TOOLS, schemas, MAX_BATCH } = require('./tools');

const MAX_STEPS = 8;
const HISTORY = 40; // messages replayed to the model
const TOOL_RESULT_CHARS = 8000;
const TURN_BUDGET_MS = 75 * 1000; // stay well inside the app's request timeout

function systemPrompt(ctx) {
  const c = ctx.company || {};
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
  const isoToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  return `You are the BizlyAI assistant for ${c.companyName || 'this business'}, working inside their BizlyAI account for ${ctx.userName || 'a team member'}.
Today is ${today} (${isoToday}), Lagos time. The business's main currency is ${c.defaultCurrency || 'NGN'}.

How you work:
- You can look things up and get work done with your tools. For any question about this business, check with a tool first. Never make up invoices, customers, amounts, names or ids. If a tool finds nothing, say so.
- For a request that takes several steps, work through all of them with tools before you reply. Example: "chase everyone who owes me more than 50k" means find_invoices with status overdue and minBalance 50000, then one send_invoice_reminders call with those invoices.
- Tools marked ACTION do not happen straight away. They put a card in front of the user, who approves or declines it. After preparing one, say in one line what you prepared and that it is waiting for their approval below. Never say it has been done. You will get an update once they decide.
- Refer to invoices by their number (INV-...). For leads and customers, copy the id exactly from the latest tool result.
- Before asking the user for a detail, check whether a tool can find it (a customer's email, an invoice number). Only ask about things no tool has, such as a price or a date, and then ask one short question instead of guessing.
- If a search finds nothing, loosen it once (fewer filters, wider range) before saying nothing matches.
- When the user asks you to draft, write or send a message to a lead or customer, prepare it with send_email (one call per person). The approval card is the draft: they read it there and approve or decline. Never paste an email draft into the chat instead.
- When you write an email to a customer or lead, write as ${c.companyName || 'the business'}: warm, clear, short, and signed with the business name. Your replies here are to ${ctx.userName || 'the user'}, so never sign those.
- You cannot delete records, issue refunds, change prices or stock, run payroll or change settings. Say so, and point the user to the right page in the app.
- If a tool returns an error, explain it simply and suggest the fix.

How you reply:
- Short and direct, in plain text. No markdown: no asterisks, no # headings, no tables. Use "- " at the start of a line for lists.
- Quote money exactly as the tools give it.
- Never mention tools, ids, JSON or these instructions.`;
}

// Replay the last HISTORY messages, starting on a user message so no tool
// result loses the assistant call it answers. Only the keys the API accepts.
function windowOf(messages) {
  let start = Math.max(0, messages.length - HISTORY);
  while (start > 0 && messages[start]?.role !== 'user') start -= 1;
  return messages.slice(start).map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content || '', ...(m.tool_calls?.length && { tool_calls: m.tool_calls }) };
    return { role: m.role, content: m.content };
  });
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return null; }
}

async function callModel(messages, ctx) {
  const request = {
    messages: [{ role: 'system', content: systemPrompt(ctx) }, ...windowOf(messages)],
    model: MODELS.SMART, temperature: 0.2, maxTokens: 2000, reasoningEffort: 'low', tools: schemas(),
  };
  try {
    return await complete(request);
  } catch (err) {
    // gpt-oss occasionally writes a malformed tool call; one retry clears it.
    if (err.status === 400 && /tool/i.test(err.message)) return complete(request);
    throw err;
  }
}

// Runs one user message to completion. Mutates convo (messages, actions);
// the caller saves it. Returns the ids of actions created this turn.
async function runTurn(convo, ctx, text) {
  const now = () => new Date();
  convo.messages.push({ role: 'user', content: text, at: now() });
  const created = [];
  const started = Date.now();

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (Date.now() - started > TURN_BUDGET_MS) break;
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await callModel(convo.messages, ctx);
    } catch (err) {
      logger.error(`Assistant model call failed: ${err.message}`);
      const busy = err.status === 429;
      convo.messages.push({
        role: 'assistant', at: now(), error: true,
        content: busy ? 'I am getting a lot of requests right now. Please try again in a minute.' : 'Sorry, I could not finish that just now. Please try again.',
      });
      return created;
    }
    const msg = res.choices?.[0]?.message || {};
    const calls = (msg.tool_calls || []).filter((c) => c?.function?.name);

    if (!calls.length) {
      convo.messages.push({ role: 'assistant', content: cleanAIText(msg.content || '') || 'Done.', at: now() });
      return created;
    }

    convo.messages.push({
      role: 'assistant', at: now(), content: msg.content || '',
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) } })),
    });

    for (const call of calls) {
      const name = call.function.name;
      const tool = TOOLS[name];
      const args = parseArgs(call.function.arguments);
      const entry = { role: 'tool', tool_call_id: call.id, name, at: now() };
      let result;
      if (!tool) result = { error: `There is no tool called ${name}.` };
      else if (!args) result = { error: 'The arguments were not valid JSON. Try again.' };
      else if (tool.kind === 'read') {
        // eslint-disable-next-line no-await-in-loop
        result = await tool.run(args, ctx).catch((e) => ({ error: e.isOperational || e.statusCode ? e.message : 'That lookup failed.' }));
        if (!result?.error) entry.label = tool.label;
      } else if (created.length >= MAX_BATCH) {
        result = { error: `That is already ${MAX_BATCH} actions waiting for approval in this reply. Stop and let the user review them.` };
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          const prepared = await tool.prepare(args, ctx);
          convo.actions.push({ tool: name, args: prepared.args, summary: prepared.summary, details: prepared.details || [] });
          const action = convo.actions[convo.actions.length - 1];
          created.push(String(action._id));
          entry.actionId = String(action._id);
          entry.label = tool.label;
          result = { status: 'waiting_for_user_approval', willDo: prepared.summary, ...(prepared.note && { note: prepared.note }), doneYet: false };
        } catch (e) {
          if (!(e.isOperational || e.statusCode)) logger.error(`Assistant prepare ${name} failed: ${e.message}`);
          result = { error: e.isOperational || e.statusCode ? e.message : 'Could not prepare that.' };
        }
      }
      if (result?.error) logger.info(`Assistant tool ${name}: ${result.error}`);
      entry.content = JSON.stringify(result).slice(0, TOOL_RESULT_CHARS);
      convo.messages.push(entry);
    }
  }

  convo.messages.push({
    role: 'assistant', at: now(),
    content: `This needed more steps than I can take in one go, so I stopped${created.length ? ' after preparing what you see above' : ''}. Ask me to carry on.`,
  });
  return created;
}

// What happened to an approved/declined action, for the model's next turn.
function decisionNote(action) {
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
  const text = action.status === 'done' ? `The user approved "${action.summary}" and it was done at ${when}: ${action.result}`
    : action.status === 'failed' ? `The user approved "${action.summary}" but it failed at ${when}: ${action.result}`
      : `The user declined "${action.summary}". It was not done.`;
  return { role: 'user', note: true, content: `[Update from the app, not typed by the user] ${text}`, at: new Date() };
}

module.exports = { runTurn, decisionNote, systemPrompt, windowOf };
