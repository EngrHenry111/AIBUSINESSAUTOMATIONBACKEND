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
};

// Every agent gets the plain-text rule appended, once, here — not copy-pasted
// into each prompt above.
Object.keys(AGENT_PROMPTS).forEach((key) => {
  AGENT_PROMPTS[key] = `${AGENT_PROMPTS[key]}\n\n${PLAIN_TEXT_RULE}`;
});

/**
 * Core completion function
 */
async function complete({ messages, model = MODELS.FAST, temperature = 0.2, maxTokens = 800, stream = false }) {
  const groq = getGroqClient();
  try {
    const response = await groq.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
      stream,
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

module.exports = { generateAnswer, generateWhatsAppReply, runAgent, streamAnswer, generateStructured, MODELS };
