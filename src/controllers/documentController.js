'use strict';

const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const KnowledgeBase = require('../models/KnowledgeBase');
const Company = require('../models/Company');
const { getEmbedding } = require('../services/embeddingService');
const chunkText = require('../utils/chunkText');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');

// ── Text extraction from local file ───────────────────────────────────────
async function extractText(fileType, localPath) {
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error(`Local file not found: ${localPath}`);
  }
  const buffer = fs.readFileSync(localPath);

  if (fileType === 'pdf') {
    const data = await pdf(buffer);
    return data.text;
  }
  if (fileType === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (fileType === 'txt') {
    return buffer.toString('utf8');
  }
  throw new Error(`Unsupported file type: ${fileType}`);
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
    let successCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await getEmbedding(chunks[i]);
        await DocumentChunk.create({
          companyId, documentId: doc._id, knowledgeBaseId: doc.knowledgeBaseId,
          source: doc.originalName, chunk: chunks[i], chunkIndex: i, embedding,
          metadata: { charCount: chunks[i].length, wordCount: chunks[i].split(/\s+/).length },
          uploadedBy: userId,
        });
        successCount++;
      } catch (e) {
        logger.warn(`Chunk ${i} embedding failed: ${e.message}`);
        await DocumentChunk.create({
          companyId, documentId: doc._id, knowledgeBaseId: doc.knowledgeBaseId,
          source: doc.originalName, chunk: chunks[i], chunkIndex: i, embedding: [],
          metadata: { charCount: chunks[i].length, wordCount: chunks[i].split(/\s+/).length },
          uploadedBy: userId,
        }).catch(() => {});
      }
    }

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