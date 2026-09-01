'use strict';

const mongoose = require('mongoose');

const documentChunkSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  knowledgeBaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase' },
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  source: { type: String, required: true },
  chunk: { type: String, required: true },
  chunkIndex: { type: Number, required: true },
  embedding: { type: [Number], required: true },
  metadata: {
    pageNumber: Number,
    wordCount: Number,
    charCount: Number,
    section: String,
  },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

documentChunkSchema.index({ companyId: 1, source: 1 });
documentChunkSchema.index({ companyId: 1, knowledgeBaseId: 1 });
documentChunkSchema.index({ documentId: 1 });

module.exports = mongoose.model('DocumentChunk', documentChunkSchema);