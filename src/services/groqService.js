'use strict';

const { getGroqClient, MODELS } = require('../config/groq');
const { cleanAIText, cleanAIObject } = require('../utils/cleanAIText');
const logger = require('../utils/logger');

// Appended to every system prompt so AI output can be pasted straight into
// WhatsApp or an email without stray markdown. cleanAIText() below is the
// belt-and-braces backstop for whenever a model ignores this anyway.
const PLAIN_TEXT_RULE = `IMPORTANT: Return plain text only. Do NOT use markdown formatting. Do NOT use asterisks (* or **) for bold. Do NOT use hashtags (#) for headings. Do NOT use underscores (_) for italics. Write in clean plain text that can be copied directly into WhatsApp or email.`;

const AGENT_PROMPTS = {
  knowledge_assistant: `You are an intelligent knowledge base assistant for a business.
Rules:
1. Answer ONLY using the provided context from company documents.
2. Never invent or hallucinate information.
3. If information is not in the context, say: "I couldn't find that information in your knowledge base."
4. Cite specific documents when possible.
5. Be concise, accurate, and professional.
6. Format lists and structured data clearly.`,

  lead_agent: `You are an expert sales and CRM assistant.
Analyze lead data and provide:
- Lead quality assessment and scoring rationale
- Personalized follow-up email drafts
- Sales strategy recommendations
- Risk factors and opportunities
Be specific, actionable, and data-driven.`,

  meeting_agent: `You are an expert meeting analyst and executive assistant.
When given a transcript or notes, extract:
- A concise executive summary (3-5 sentences)
- Key decisions made (bulleted list)
- Action items with owners and deadlines
- Risks or blockers mentioned
- Recommended follow-ups
Be precise and attribute items to specific people when mentioned.`,

  invoice_agent: `You are a professional accounts receivable assistant.
When drafting payment reminders:
- Be firm but professional
- Reference the specific invoice number and amount
- Provide clear payment instructions
- Escalate tone appropriately based on days overdue
- Never be threatening or unprofessional`,

  support_agent: `You are a customer support specialist.
Analyze support tickets and:
- Classify the issue type accurately
- Assess urgency (critical/high/medium/low)
- Draft a helpful, empathetic response
- Suggest whether human escalation is needed
- Identify patterns across similar tickets`,

  social_agent: `You are a creative social media strategist.
Create engaging content that:
- Fits the platform's tone and format
- Includes relevant hashtags
- Has a strong hook in the first line
- Drives engagement and action
- Maintains brand voice`,

  report_agent: `You are a business intelligence analyst.
Generate reports that include:
- Executive summary with key metrics
- Trend analysis with specific numbers
- Comparison to previous period
- Identified problems or anomalies
- Data-driven recommendations
Use clear headings and bullet points.`,

  hr_agent: `You are an HR specialist assistant.
Help with:
- Policy clarification
- Job description writing
- Performance review drafting
- Employee communication
- Compliance and best practices
Be professional, fair, and legally careful.`,

  analytics_agent: `You are a data analyst assistant.
Provide:
- Clear interpretation of metrics
- Trend identification
- Anomaly detection
- Actionable insights
- Forecasting where relevant
Base all analysis on the provided data only.`,

  contract_agent: `You are an expert Nigerian commercial lawyer drafting business contracts.
Rules:
- Use precise, professional legal language suitable for Nigerian business law and the Companies and Allied Matters Act (CAMA) 2020.
- Use ONLY the party names, dates, amounts and terms given to you — never invent details that weren't provided.
- Number every clause and sub-clause.
- Default to Nigerian courts and Nigerian law for dispute resolution and governing law unless told otherwise.
- Write out section headings in capitals on their own line, followed by numbered clauses.
- This is a first draft for the business to review and have checked by a qualified lawyer before signing — do not claim it has already been legally reviewed.`,
};

// Every agent gets the plain-text rule appended, once, here — not copy-pasted
// into each prompt above.
Object.keys(AGENT_PROMPTS).forEach((key) => {
  AGENT_PROMPTS[key] = `${AGENT_PROMPTS[key]}\n\n${PLAIN_TEXT_RULE}`;
});

/**
 * Core completion function
 */
async function complete({ messages, model = MODELS.FAST, temperature = 0.2, maxTokens = 800, stream = false, reasoningEffort = 'low', tools }) {
  const groq = getGroqClient();
  try {
    const response = await groq.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
      stream,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      // The openai/gpt-oss-* models spend part of max_tokens on a hidden
      // reasoning pass before the actual answer — 'low' keeps that overhead
      // small so existing maxTokens budgets (tuned for the old non-reasoning
      // model) don't get eaten up and truncate the real output to nothing.
      ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: reasoningEffort } : {}),
    });
    return response;
  } catch (err) {
    logger.error('Groq completion error:', { error: err.message, model });
    throw err;
  }
}

/**
 * Knowledge base Q&A
 */
async function generateAnswer(context, question, conversationHistory = []) {
  const systemPrompt = AGENT_PROMPTS.knowledge_assistant;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-6), // Last 3 exchanges for context
    {
      role: 'user',
      content: `KNOWLEDGE BASE CONTEXT:\n\n${context}\n\n---\n\nQUESTION: ${question}`,
    },
  ];

  const response = await complete({ messages, model: MODELS.SMART, maxTokens: 1000 });
  return cleanAIText(response.choices[0].message.content);
}

/**
 * Customer-facing WhatsApp reply — short, warm, plain text, grounded in context.
 */
async function generateWhatsAppReply(context, question, history = []) {
  const systemPrompt = `You are a friendly customer-support assistant replying on WhatsApp for a business.
Rules:
1. Answer using ONLY the provided knowledge base context.
2. If the answer is not in the context, briefly say you'll connect them with a team member — do not guess.
3. Keep replies short and conversational: 1-3 sentences, WhatsApp style. No markdown, no headings, no bullet characters.
4. Be warm, human and professional. Never mention "context" or "documents".

${PLAIN_TEXT_RULE}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: `KNOWLEDGE BASE:\n${context}\n\n---\nCUSTOMER MESSAGE: ${question}` },
  ];

  const response = await complete({ messages, model: MODELS.SMART, maxTokens: 400, temperature: 0.3 });
  return cleanAIText(response.choices[0].message.content);
}

/**
 * The inbox sales assistant: answers a customer from the business's
 * knowledge, live product catalog and what's known about this customer.
 * Returns HANDOVER_TOKEN when a person should take it.
 */
const HANDOVER_TOKEN = '[HANDOVER]';
async function generateSalesReply({ businessName, knowledge, catalog, customer, question, history = [] }) {
  const systemPrompt = `You are the sales and customer assistant for ${businessName || 'this business'}, chatting with a customer on WhatsApp or the website.
Use ONLY the information below (business information, product catalog, customer details). Never invent products, prices, discounts, stock, delivery times or policies.

How to help:
1. Product questions: recommend matching products with their exact price and availability. Mention at most 4 products, most relevant first. Include a product's link when they want to buy or see it.
2. "What do you sell?": summarise the kinds of products and name a few popular ones with prices, then ask what they're looking for.
3. If something is out of stock, say so and suggest a similar in-stock product if there is one.
4. To order: send the product link or store link. Never take payment details in chat.
5. Order questions: use the customer's recent orders (status, payment, tracking link). Only discuss orders listed for this customer.
6. Greet a returning customer by name when you know it, and use what they asked before when it helps. Don't recite their history.
7. If you can't answer from the information, or they want a person, a refund, a complaint handled, a custom deal or anything you're unsure of, reply with exactly ${HANDOVER_TOKEN} and nothing else.

Style: warm, short and natural, like a helpful shop assistant on WhatsApp. 1 to 4 short sentences, or a short list with one product per line. Never mention "context", "catalog data" or "information provided".
${PLAIN_TEXT_RULE}`;

  const sections = [];
  if (knowledge) sections.push(`BUSINESS INFORMATION:\n${knowledge}`);
  if (catalog) sections.push(`PRODUCT CATALOG:\n${catalog}`);
  if (customer) sections.push(`THIS CUSTOMER:\n${customer}`);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8),
    { role: 'user', content: `${sections.join('\n\n---\n\n')}\n\n---\nCUSTOMER MESSAGE: ${question}` },
  ];

  const response = await complete({ messages, model: MODELS.SMART, maxTokens: 500, temperature: 0.3 });
  const text = cleanAIText(response.choices[0].message.content || '');
  return text.includes(HANDOVER_TOKEN) ? HANDOVER_TOKEN : text;
}

/**
 * Reads a customer chat and says where they are in buying. Cheap model,
 * JSON only. Never throws on a bad answer: returns null.
 * @returns {Promise<{stage, products, summary, estimatedValue}|null>}
 */
const SALE_STAGES = ['browsing', 'interested', 'ready_to_buy', 'ordered', 'not_interested', 'support'];
async function classifySale({ businessName, transcript }) {
  const systemPrompt = `You read a chat between a customer and ${businessName || 'a business'} and judge how close the customer is to buying.
Answer ONLY with JSON: {"stage": "...", "products": ["..."], "summary": "...", "estimatedValue": 0}
stage, pick one:
- browsing: general questions, no clear product interest yet
- interested: asked about specific products, prices, sizes, stock or delivery
- ready_to_buy: said they want to buy or order, asked how to pay, or asked for the link to order
- ordered: says they have already ordered or paid
- not_interested: declined, said no thanks, too expensive and stopped, or asked not to be contacted
- support: only about an existing order, a complaint, a refund or a problem
products: names of products they showed interest in, as written in the chat (max 5, may be empty).
summary: one short sentence about what they want, for the sales team.
estimatedValue: total price in naira of what they seem to want, from prices in the chat, else 0.`;
  try {
    const response = await complete({
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: transcript }],
      model: MODELS.FAST, temperature: 0, maxTokens: 500,
    });
    const raw = String(response.choices[0].message.content || '').replace(/```json|```/g, '').trim();
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (!SALE_STAGES.includes(json.stage)) return null;
    return {
      stage: json.stage,
      products: (Array.isArray(json.products) ? json.products : []).map((x) => cleanAIText(String(x)).slice(0, 80)).filter(Boolean).slice(0, 5),
      summary: cleanAIText(String(json.summary || '')).slice(0, 300),
      estimatedValue: Math.max(0, Math.round(Number(json.estimatedValue) || 0)),
    };
  } catch (err) {
    logger.warn(`Sale classification failed: ${err.message}`);
    return null;
  }
}

/**
 * One short follow-up to a customer who went quiet. Returns SKIP_TOKEN
 * when a follow-up would be wrong (they declined, complained, already bought).
 */
const SKIP_TOKEN = '[SKIP]';
async function generateFollowUp({ businessName, catalog, customerName, interest, history = [] }) {
  const systemPrompt = `You are the sales assistant for ${businessName || 'this business'} on WhatsApp. The customer chatted earlier and then stopped replying. Write ONE short, friendly follow-up message to them.
Rules:
- Refer to what they were interested in${interest ? ` (${interest})` : ''}, using the exact product name, current price and availability from the PRODUCT CATALOG. Include the product link if they might want to order.
- If that product is now out of stock, say so kindly and suggest one similar in-stock product from the catalog, if any.
- You may mention low stock only if the catalog says "Only N left". Never invent discounts, deadlines, delivery times or anything not in the catalog.
- Helpful, not pushy. End with one simple question (for example whether they have any questions or would like help ordering).
- 1 to 3 short sentences. Greet them by first name if you know it. Don't say you're an AI and don't mention this is an automatic message.
- If a follow-up would be inappropriate (they declined, complained, asked for a refund, said they already ordered, or the chat was fully resolved), reply with exactly ${SKIP_TOKEN} and nothing else.
${PLAIN_TEXT_RULE}`;
  const sections = [];
  if (customerName) sections.push(`CUSTOMER NAME: ${customerName}`);
  if (catalog) sections.push(`PRODUCT CATALOG:\n${catalog}`);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user', content: `${sections.join('\n\n')}\n\n---\nWrite the follow-up message now.` },
  ];
  const response = await complete({ messages, model: MODELS.SMART, maxTokens: 400, temperature: 0.4 });
  const text = cleanAIText(response.choices[0].message.content || '');
  return !text || text.includes(SKIP_TOKEN) ? SKIP_TOKEN : text;
}

/**
 * Generic agent execution
 */
async function runAgent(agentType, input, options = {}) {
  const systemPrompt = AGENT_PROMPTS[agentType] || AGENT_PROMPTS.knowledge_assistant;
  const model = options.useSmartModel ? MODELS.SMART : MODELS.FAST;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input, null, 2) },
  ];

  const response = await complete({ messages, model, maxTokens: options.maxTokens || 1200, temperature: options.temperature || 0.3 });
  return cleanAIText(response.choices[0].message.content);
}

/**
 * Streaming response for real-time chat. Chunks are yielded as raw tokens —
 * they can't be run through cleanAIText() individually (a "**" could land
 * split across two chunks) — so this relies on the knowledge_assistant
 * system prompt's plain-text rule instead. The non-streaming generateAnswer()
 * above still gets the full cleanAIText() pass.
 */
async function* streamAnswer(context, question, conversationHistory = []) {
  const messages = [
    { role: 'system', content: AGENT_PROMPTS.knowledge_assistant },
    ...conversationHistory.slice(-6),
    { role: 'user', content: `CONTEXT:\n\n${context}\n\nQUESTION: ${question}` },
  ];

  const stream = await complete({ messages, model: MODELS.SMART, maxTokens: 1000, stream: true });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/**
 * Structured JSON output from AI
 */
async function generateStructured(prompt, schema, agentType = 'knowledge_assistant') {
  // AGENT_PROMPTS[agentType] already carries PLAIN_TEXT_RULE, which also
  // keeps any free-text *values* inside the JSON (summaries, drafts, …) clean.
  const systemPrompt = `${AGENT_PROMPTS[agentType]}\n\nCRITICAL: Respond ONLY with valid JSON matching this schema: ${JSON.stringify(schema)}. No markdown, no backticks, no explanation.`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const response = await complete({ messages, model: MODELS.SMART, temperature: 0.1, maxTokens: 1500 });
  const raw = response.choices[0].message.content.trim();

  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return cleanAIObject(parsed);
  } catch {
    logger.warn('Failed to parse structured AI response, returning raw:', raw.substring(0, 200));
    return { raw: cleanAIText(raw) };
  }
}

module.exports = { complete, generateAnswer, generateWhatsAppReply, generateSalesReply, HANDOVER_TOKEN, classifySale, generateFollowUp, SKIP_TOKEN, SALE_STAGES, runAgent, streamAnswer, generateStructured, MODELS };
