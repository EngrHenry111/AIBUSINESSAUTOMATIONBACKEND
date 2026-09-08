'use strict';

const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const KnowledgeBase = require('../models/KnowledgeBase');
const Company = require('../models/Company');
const { getEmbedding } = require('../services/embeddingService');
const chunkText = require('../utils/chunkText');
const { AppError } = require('../middleware/errorMiddleware');
const { downloadFile } = require('../utils/downloadFile');
const logger = require('../utils/logger');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');

// ── Text extraction ───────────────────────────────────────────────────────
async function extractTextFromBuffer(fileType, buffer) {
  if (fileType === 'pdf') return (await pdf(buffer)).text;
  if (fileType === 'docx') return (await mammoth.extractRawText({ buffer })).value;
  if (fileType === 'txt') return buffer.toString('utf8');
  throw new Error(`Unsupported file type: ${fileType}`);
}

async function extractText(fileType, localPath) {
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error(`Local file not found: ${localPath}`);
  }
  return extractTextFromBuffer(fileType, fs.readFileSync(localPath));
}

// ── Chunk one document's text and persist its embedded chunks ─────────────
async function saveEmbeddedChunks(doc, chunkArray, companyId, userId) {
  let successCount = 0;
  for (let i = 0; i < chunkArray.length; i++) {
    const base = {
      companyId, documentId: doc._id, knowledgeBaseId: doc.knowledgeBaseId,
      source: doc.originalName, chunk: chunkArray[i], chunkIndex: i,
      metadata: { charCount: chunkArray[i].length, wordCount: chunkArray[i].split(/\s+/).length },
      uploadedBy: userId,
    };
    try {
      const embedding = await getEmbedding(chunkArray[i]);
      await DocumentChunk.create({ ...base, embedding });
      successCount++;
    } catch (e) {
      logger.warn(`Chunk ${i} embedding failed: ${e.message}`);
      await DocumentChunk.create({ ...base, embedding: [] }).catch(() => {});
    }
  }
  return successCount;
}

// ── Upload to Cloudinary in background (optional) ─────────────────────────
async function uploadToCloudinary(localPath, companyId, originalName) {
  try {
    const { cloudinary } = require('../config/cloudinary');
    if (!cloudinary) return null;

    const result = await cloudinary.uploader.upload(localPath, {
      folder: `business-ai/${companyId}/documents`,
      resource_type: 'raw',
      use_filename: true,
      unique_filename: true,
      overwrite: false,
    });
    logger.info(`Uploaded to Cloudinary: ${result.secure_url}`);
    return { url: result.secure_url, publicId: result.public_id };
  } catch (err) {
    logger.warn(`Cloudinary upload failed (file still processed locally): ${err.message}`);
    return null;
  }
}

// ── Upload handler ─────────────────────────────────────────────────────────
exports.uploadDocument = async (req, res, next) => {
  let documentRecord = null;
  try {
    const file = req.file;
    if (!file) return next(new AppError('No file received.', 400));

    logger.info(`Upload received: ${file.originalname} (${file.size} bytes) at ${file.path}`);

    const fileExt = file.originalname.split('.').pop().toLowerCase();
    if (!['pdf', 'docx', 'txt'].includes(fileExt)) {
      return next(new AppError('Only PDF, DOCX, and TXT files are supported.', 400));
    }

    const { knowledgeBaseId, description, tags } = req.body;
    if (knowledgeBaseId) {
      const kb = await KnowledgeBase.findOne({ _id: knowledgeBaseId, companyId: req.companyId });
      if (!kb) return next(new AppError('Knowledge base not found.', 404));
    }

    documentRecord = await Document.create({
      companyId: req.companyId,
      knowledgeBaseId: knowledgeBaseId || null,
      uploadedBy: req.user._id,
      name: file.originalname,
      originalName: file.originalname,
      fileType: fileExt,
      fileSize: file.size,
      cloudinaryUrl: null,        // will be set after background upload
      cloudinaryPublicId: null,
      description: description || '',
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      status: 'extracting',
    });

    // Respond immediately
    res.status(202).json({
      success: true,
      message: 'Document uploaded. Processing started.',
      documentId: documentRecord._id,
    });

    // Process async
    processDocument(documentRecord, file.path, req.companyId, req.user._id);

  } catch (err) {
    logger.error('uploadDocument error:', err.message);
    if (documentRecord) {
      await Document.findByIdAndUpdate(documentRecord._id, {
        status: 'failed', processingError: err.message,
      }).catch(() => {});
    }
    next(err);
  }
};

// ── Async processing pipeline ──────────────────────────────────────────────
async function processDocument(doc, localPath, companyId, userId) {
  try {
    logger.info(`Processing: ${doc.name} from ${localPath}`);

    // 1. Extract text from LOCAL file (no download needed)
    await Document.findByIdAndUpdate(doc._id, { status: 'extracting' });
    const text = await extractText(doc.fileType, localPath);

    if (!text || text.trim().length === 0) {
      throw new Error('No text could be extracted from this document.');
    }
    logger.info(`Extracted ${text.length} chars from ${doc.name}`);

    // 2. Chunk
    await Document.findByIdAndUpdate(doc._id, { status: 'chunking' });
    const chunks = chunkText(text, { chunkSize: 800, overlap: 150 });
    logger.info(`${doc.name}: ${chunks.length} chunks`);
    if (chunks.length === 0) throw new Error('Document produced no chunks.');

    // 3. Embed
    await Document.findByIdAndUpdate(doc._id, { status: 'embedding' });
    const successCount = await saveEmbeddedChunks(doc, chunks, companyId, userId);

    // 4. Mark ready
    await Document.findByIdAndUpdate(doc._id, {
      status: 'ready',
      chunksCount: successCount,
      wordCount: text.split(/\s+/).length,
    });

    await Company.findByIdAndUpdate(companyId, {
      $inc: { 'usage.documentsCount': 1, 'usage.chunksCount': successCount },
    });
    if (doc.knowledgeBaseId) {
      await KnowledgeBase.findByIdAndUpdate(doc.knowledgeBaseId, { $inc: { documentsCount: 1 } });
    }

    logger.info(`✅ ${doc.name}: ${successCount}/${chunks.length} chunks embedded`);

    // 5. Upload to Cloudinary for backup (non-blocking, after processing is done)
    const cloudResult = await uploadToCloudinary(localPath, companyId, doc.originalName);
    if (cloudResult) {
      await Document.findByIdAndUpdate(doc._id, {
        cloudinaryUrl: cloudResult.url,
        cloudinaryPublicId: cloudResult.publicId,
      });
    }

    // 6. Clean up temp file
    try {
      if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch (e) {
      logger.warn(`Could not delete temp file ${localPath}: ${e.message}`);
    }

  } catch (err) {
    logger.error(`❌ processDocument failed for ${doc.name}: ${err.message}`);
    await Document.findByIdAndUpdate(doc._id, {
      status: 'failed', processingError: err.message,
    }).catch(() => {});
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────
exports.getDocuments = async (req, res, next) => {
  try {
    const { knowledgeBaseId, status, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (knowledgeBaseId) filter.knowledgeBaseId = knowledgeBaseId;
    if (status) filter.status = status;
    const [documents, total] = await Promise.all([
      Document.find(filter)
        .populate('uploadedBy', 'name avatar')
        .populate('knowledgeBaseId', 'name color')
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Document.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: documents,
      pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

exports.getDocument = async (req, res, next) => {
  try {
    const document = await Document.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('uploadedBy', 'name avatar').populate('knowledgeBaseId', 'name color');
    if (!document) return next(new AppError('Document not found.', 404));
    const chunks = await DocumentChunk.find({ documentId: req.params.id, companyId: req.companyId })
      .select('-embedding').sort({ chunkIndex: 1 });
    res.status(200).json({ success: true, data: { ...document.toJSON(), chunks } });
  } catch (err) { next(err); }
};

exports.deleteDocument = async (req, res, next) => {
  try {
    const document = await Document.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!document) return next(new AppError('Document not found.', 404));
    const chunksDeleted = await DocumentChunk.deleteMany({ documentId: document._id, companyId: req.companyId });
    await document.deleteOne();
    await Company.findByIdAndUpdate(req.companyId, {
      $inc: { 'usage.documentsCount': -1, 'usage.chunksCount': -chunksDeleted.deletedCount },
    });
    res.status(200).json({ success: true, message: 'Document deleted.', deletedChunks: chunksDeleted.deletedCount });
  } catch (err) { next(err); }
};

exports.getDocumentStatus = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, companyId: req.companyId })
      .select('status processingError chunksCount name');
    if (!doc) return next(new AppError('Document not found.', 404));
    res.status(200).json({ success: true, data: doc });
  } catch (err) { next(err); }
};

// ── POST /documents/:id/reembed — wipe chunks and reprocess ───────────────
exports.reembed = async (req, res, next) => {
  const IN_PROGRESS = ['uploading', 'extracting', 'chunking', 'embedding', 'indexing', 'processing'];
  try {
    const doc = await Document.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!doc) return next(new AppError('Document not found.', 404));
    if (IN_PROGRESS.includes(doc.status)) {
      return next(new AppError('This document is already being processed.', 409));
    }
    if (!doc.cloudinaryUrl) {
      return next(new AppError('The original file is no longer stored for this document. Re-upload it to re-embed.', 422));
    }

    // 1. Remove existing chunks
    const removed = await DocumentChunk.deleteMany({ documentId: doc._id, companyId: req.companyId });

    // 2. Mark processing
    doc.status = 'processing';
    doc.processingError = undefined;
    doc.chunksCount = 0;
    await doc.save();

    // 3. Re-run the pipeline from the stored original file
    const buffer = await downloadFile(doc.cloudinaryUrl, doc.cloudinaryPublicId);
    const text = await extractTextFromBuffer(doc.fileType, buffer);
    if (!text || !text.trim()) throw new Error('No text could be extracted from the stored file.');

    const chunks = chunkText(text, { chunkSize: 800, overlap: 150 });
    if (!chunks.length) throw new Error('Document produced no chunks.');

    const newCount = await saveEmbeddedChunks(doc, chunks, req.companyId, doc.uploadedBy || req.user._id);

    doc.status = 'ready';
    doc.chunksCount = newCount;
    doc.wordCount = text.split(/\s+/).length;
    await doc.save();

    // Keep the company chunk counter roughly in sync
    await Company.findByIdAndUpdate(req.companyId, {
      $inc: { 'usage.chunksCount': newCount - (removed.deletedCount || 0) },
    });

    logger.info(`♻️  Re-embedded ${doc.name}: ${newCount} chunks (was ${removed.deletedCount})`);
    res.status(200).json({ success: true, chunks: newCount });
  } catch (err) {
    logger.error(`reembed failed for ${req.params.id}: ${err.message}`);
    await Document.findByIdAndUpdate(req.params.id, { status: 'failed', processingError: err.message }).catch(() => {});
    next(new AppError('Re-embed failed. Please try again.', 500));
  }
};