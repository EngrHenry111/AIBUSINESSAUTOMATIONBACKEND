'use strict';

function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// BM25-style keyword score (simplified)
function bm25Score(text, queryTerms, k1 = 1.5, b = 0.75, avgDocLen = 600) {
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  const docLen = tokens.length;
  let score = 0;

  for (const term of queryTerms) {
    if (term.length < 3) continue;
    const tf = tokens.filter(t => t === term).length;
    if (tf === 0) continue;
    const idf = Math.log(1 + 1 / (0.5 + tf)); // simplified IDF
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen));
    score += idf * tfNorm;
  }
  return score;
}

function hybridSearch(chunks, questionEmbedding, question, options = {}) {
  // If no embedding available, fall back to pure keyword search
  if (!questionEmbedding || questionEmbedding.length === 0) {
    const queryTerms = question.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    return chunks
      .filter(c => c.chunk && c.chunk.length > 0)
      .map(item => {
        const rawKeyword = bm25Score(item.chunk, queryTerms);
        const score = Math.min(rawKeyword / 5, 1);
        return { ...item, score, semanticScore: 0, keywordScore: score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK || 8);
  }
  const {
    topK = 8,
    semanticWeight = 0.65,
    keywordWeight = 0.35,
    minScore = 0.15,
  } = options;

  const queryTerms = question.toLowerCase().split(/\W+/).filter(t => t.length > 2);

  // Score all chunks
  const scored = chunks.map(item => {
    const semanticScore = cosineSimilarity(item.embedding, questionEmbedding);
    const rawKeyword = bm25Score(item.chunk, queryTerms);

    // Normalize keyword score to [0,1] range
    const keywordScore = Math.min(rawKeyword / 5, 1);

    const hybridScore = (semanticScore * semanticWeight) + (keywordScore * keywordWeight);

    return { ...item, score: hybridScore, semanticScore, keywordScore };
  });

  return scored
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function rerankChunks(chunks, question) {
  const questionWords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const questionLower = question.toLowerCase();

  return chunks.map(chunk => {
    const text = chunk.chunk.toLowerCase();

    // Exact phrase bonus
    const phraseBonus = text.includes(questionLower) ? 0.2 : 0;

    // Keyword density score
    const matches = questionWords.filter(w => text.includes(w)).length;
    const keywordDensity = questionWords.length > 0 ? matches / questionWords.length : 0;

    // Position bonus (earlier chunks tend to have headings and summaries)
    const positionBonus = chunk.chunkIndex === 0 ? 0.05 : 0;

    const finalScore = (chunk.score * 0.7) + (keywordDensity * 0.2) + phraseBonus + positionBonus;

    return { ...chunk, rerankScore: finalScore };
  }).sort((a, b) => b.rerankScore - a.rerankScore);
}

module.exports = { hybridSearch, rerankChunks, cosineSimilarity };