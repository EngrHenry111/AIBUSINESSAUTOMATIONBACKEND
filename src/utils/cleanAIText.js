'use strict';

/**
 * Strip markdown formatting AI models sometimes emit despite instructions,
 * so text can be pasted straight into WhatsApp or an email without stray
 * asterisks, hashtags, underscores or backticks showing up.
 */
function cleanAIText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // remove **bold**
    .replace(/\*([^*]+)\*/g, '$1')      // remove *italic*
    .replace(/#{1,6}\s/g, '')           // remove # headings
    .replace(/_{2}([^_]+)_{2}/g, '$1') // remove __bold__
    .replace(/\_([^_]+)\_/g, '$1')     // remove _italic_
    .replace(/`([^`]+)`/g, '$1')       // remove `code`
    .trim();
}

/**
 * Recursively apply cleanAIText to every string in a parsed AI JSON response
 * (generateStructured() results), so nested fields like followUpDraft or
 * executiveSummary come back plain too. Non-string values pass through.
 */
function cleanAIObject(value) {
  if (typeof value === 'string') return cleanAIText(value);
  if (Array.isArray(value)) return value.map(cleanAIObject);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = cleanAIObject(val);
    return out;
  }
  return value;
}

module.exports = { cleanAIText, cleanAIObject };
