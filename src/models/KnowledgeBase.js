'use strict';

const mongoose = require('mongoose');

const knowledgeBaseSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, maxlength: 500 },
  color: { type: String, default: '#6366f1' },
  icon: { type: String, default: 'book' },
  isDefault: { type: Boolean, default: false },
  documentsCount: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

knowledgeBaseSchema.index({ companyId: 1 });

module.exports = mongoose.model('KnowledgeBase', knowledgeBaseSchema);