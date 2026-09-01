'use strict';

const KnowledgeBase = require('../models/KnowledgeBase');
const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const { AppError } = require('../middleware/errorMiddleware');

exports.getKnowledgeBases = async (req, res, next) => {
  try {
    const kbs = await KnowledgeBase.find({ companyId: req.companyId })
      .populate('createdBy', 'name').sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: kbs });
  } catch (err) { next(err); }
};

exports.createKnowledgeBase = async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.create({
      ...req.body,
      companyId: req.companyId,
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, data: kb });
  } catch (err) { next(err); }
};

exports.getKnowledgeBase = async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!kb) return next(new AppError('Knowledge base not found.', 404));

    const documents = await Document.find({ knowledgeBaseId: kb._id, companyId: req.companyId, status: 'ready' })
      .select('name fileType fileSize chunksCount createdAt uploadedBy')
      .populate('uploadedBy', 'name');

    res.status(200).json({ success: true, data: { ...kb.toJSON(), documents } });
  } catch (err) { next(err); }
};

exports.updateKnowledgeBase = async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      req.body, { new: true }
    );
    if (!kb) return next(new AppError('Knowledge base not found.', 404));
    res.status(200).json({ success: true, data: kb });
  } catch (err) { next(err); }
};

exports.deleteKnowledgeBase = async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!kb) return next(new AppError('Knowledge base not found.', 404));
    if (kb.isDefault) return next(new AppError('Cannot delete the default knowledge base.', 400));

    // Unlink documents (don't delete them, just remove KB association)
    await Document.updateMany({ knowledgeBaseId: kb._id }, { $unset: { knowledgeBaseId: 1 } });
    await DocumentChunk.updateMany({ knowledgeBaseId: kb._id }, { $unset: { knowledgeBaseId: 1 } });
    await kb.deleteOne();

    res.status(200).json({ success: true, message: 'Knowledge base deleted. Documents have been moved to general storage.' });
  } catch (err) { next(err); }
};
