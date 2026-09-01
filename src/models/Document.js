'use strict';

const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  knowledgeBaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase' },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  originalName: { type: String, required: true },
  fileType: { type: String, enum: ['pdf', 'docx', 'txt'], required: true },
  fileSize: { type: Number, required: true },
  cloudinaryUrl: { type: String },
  cloudinaryPublicId: { type: String },
  status: {
    type: String,
    enum: ['uploading', 'extracting', 'chunking', 'embedding', 'indexing', 'ready', 'failed'],
    default: 'uploading',
  },
  processingError: { type: String },
  chunksCount: { type: Number, default: 0 },
  wordCount: { type: Number, default: 0 },
  tags: [{ type: String, trim: true }],
  description: { type: String, maxlength: 500 },
}, { timestamps: true });

// Compound indexes cover companyId lookups — no need for inline index: true
documentSchema.index({ companyId: 1, status: 1 });
documentSchema.index({ companyId: 1, knowledgeBaseId: 1 });
documentSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('Document', documentSchema);