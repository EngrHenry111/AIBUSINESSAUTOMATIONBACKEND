'use strict';

const { generateStructured } = require('../services/groqService');
const { cleanAIText } = require('./cleanAIText');

const SOURCE_LABELS = {
  chat_widget: 'website chat', whatsapp: 'WhatsApp', store: 'online store', business_card: 'business card',
};

// Scores a lead and drafts a follow-up with the AI, saving the result on it.
async function analyzeLeadRecord(lead) {
  const recent = (lead.activities || []).slice(-8).map((a) => `${a.type}: ${a.description}`).join(' | ');
  const prompt = `Analyze this sales lead and provide a JSON response:

Lead Data:
- Name: ${lead.name}
- Email: ${lead.email || 'Unknown'}
- Phone: ${lead.phone || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
- Position: ${lead.position || 'Unknown'}
- Source: ${SOURCE_LABELS[lead.source] || lead.source}
- Status: ${lead.status}
- Value: ${lead.value} ${lead.currency}
- Last contacted: ${lead.lastContactedAt ? new Date(lead.lastContactedAt).toDateString() : 'Never'}
- Notes: ${[lead.description, ...(lead.notes || []).map((n) => n.content)].filter(Boolean).join(' | ') || 'None'}
- Recent activity: ${recent || 'None'}

Provide analysis with lead quality score (0-100), recommended next action, urgency, and a professional follow-up email draft.`;

  const schema = {
    score: 'number 0-100',
    priority: 'high|medium|low',
    sentiment: 'positive|neutral|negative',
    summary: 'string',
    recommendedAction: 'string',
    followUpDraft: 'string (full email)',
  };

  const analysis = await generateStructured(prompt, schema, 'lead_agent');

  lead.score = analysis.score || lead.score;
  lead.ai = {
    summary: cleanAIText(analysis.summary),
    recommendedAction: cleanAIText(analysis.recommendedAction),
    followUpDraft: cleanAIText(analysis.followUpDraft),
    sentiment: analysis.sentiment,
    priority: analysis.priority,
    analyzedAt: new Date(),
  };
  await lead.save();
  return lead;
}

module.exports = { analyzeLeadRecord };
