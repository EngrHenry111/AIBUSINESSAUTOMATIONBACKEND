'use strict';

/**
 * Sentence-aware chunking with overlap.
 * Respects sentence boundaries to avoid cutting mid-sentence,
 * adds configurable overlap for better context continuity.
 */
function chunkText(text, options = {}) {
  const {
    chunkSize = 800,
    overlap = 150,
    minChunkSize = 100,
  } = options;

  if (!text || text.trim().length === 0) return [];

  // Normalize whitespace
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Split into sentences (handles periods, !, ?, and newlines)
  const sentences = normalized
    .split(/(?<=[.!?])\s+|(?<=\n)\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const chunks = [];
  let currentChunk = '';
  let currentLength = 0;

  for (const sentence of sentences) {
    const sentenceLen = sentence.length;

    // If single sentence exceeds chunk size, split it by words
    if (sentenceLen > chunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
        currentLength = 0;
      }
      const words = sentence.split(' ');
      let wordChunk = '';
      for (const word of words) {
        if (wordChunk.length + word.length + 1 > chunkSize && wordChunk) {
          chunks.push(wordChunk.trim());
          wordChunk = word;
        } else {
          wordChunk += (wordChunk ? ' ' : '') + word;
        }
      }
      if (wordChunk) currentChunk = wordChunk;
      currentLength = currentChunk.length;
      continue;
    }

    if (currentLength + sentenceLen + 1 > chunkSize && currentChunk) {
      if (currentChunk.trim().length >= minChunkSize) {
        chunks.push(currentChunk.trim());
      }
      // Apply overlap: carry last N chars into next chunk
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + ' ' + sentence;
      currentLength = currentChunk.length;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
      currentLength += sentenceLen + 1;
    }
  }

  if (currentChunk.trim().length >= minChunkSize) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

module.exports = chunkText;
