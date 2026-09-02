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

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'mixtral-8x7b-32768';

const MODELS = {
  FAST: DEFAULT_MODEL,
  SMART: DEFAULT_MODEL,
  REASONING: DEFAULT_MODEL,
};

module.exports = { getGroqClient, MODELS };