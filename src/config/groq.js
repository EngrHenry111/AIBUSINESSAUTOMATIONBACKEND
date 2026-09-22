'use strict';

const Groq = require('groq-sdk');
const logger = require('../utils/logger');

let groqClient = null;

function getGroqClient() {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY environment variable is not set');
    }
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    logger.info('Groq client initialized');
  }
  return groqClient;
}

// mixtral-8x7b-32768 (the old single default for all three tiers) was
// decommissioned by Groq — every AI feature on the platform was silently
// failing until this was caught while building the contract generator.
// openai/gpt-oss-* are Groq's current models; confirmed live against
// groq.models.list() and a real completion call before landing this.
const MODELS = {
  FAST: process.env.GROQ_MODEL_FAST || 'openai/gpt-oss-20b',
  SMART: process.env.GROQ_MODEL_SMART || 'openai/gpt-oss-120b',
  REASONING: process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b',
};

module.exports = { getGroqClient, MODELS };