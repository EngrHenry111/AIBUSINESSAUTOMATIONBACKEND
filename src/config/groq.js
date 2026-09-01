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

const MODELS = {
  FAST: 'llama-3.1-8b-instant',
  SMART: 'llama-3.1-8b-instant',
  REASONING: 'llama-3.1-8b-instant',
};

module.exports = { getGroqClient, MODELS };
