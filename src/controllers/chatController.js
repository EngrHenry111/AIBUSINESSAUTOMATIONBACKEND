'use strict';

const Chat = require('../models/Chat');
const DocumentChunk = require('../models/DocumentChunk');
const Company = require('../models/Company');
const { getEmbedding } = require('../services/embeddingService');
const { generateAnswer, streamAnswer } = require('../services/groqService');
const { hybridSearch, rerankChunks } = require('../utils/hybridSearch');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');

exports.createChat = async (req, res, next) => {
  try {
    const { title, knowledgeBaseId } = req.body;
    const chat = await Chat.create({
      companyId: req.companyId,
      userId: req.user._id,
      title: title || 'New conversation',
      knowledgeBaseId: knowledgeBaseId || null,
    });
    res.status(201).json({ success: true, data: chat });
  } catch (err) { next(err); }
};

exports.getChats = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, archived = false } = req.query;
    const filter = { companyId: req.companyId, userId: req.user._id, isArchived: archived === 'true' };
    const skip = (page - 1) * limit;

    const [chats, total] = await Promise.all([
      Chat.find(filter)
        .select('title lastMessageAt messages createdAt knowledgeBaseId isArchived')
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Chat.countDocuments(filter),
    ]);

    const formatted = chats.map(c => ({
      ...c.toJSON(),
      messageCount: c.messages.length,
      lastMessage: c.messages[c.messages.length - 1]?.content?.substring(0, 100),
    }));

    res.status(200).json({
      success: true,
      data: formatted,
      pagination: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) { next(err); }
};

exports.getChat = async (req, res, next) => {
  try {
    const chat = await Chat.findOne({ _id: req.params.id, companyId: req.companyId, userId: req.user._id });
    if (!chat) return next(new AppError('Conversation not found.', 404));
    res.status(200).json({ success: true, data: chat });
  } catch (err) { next(err); }
};

exports.askQuestion = async (req, res, next) => {
  try {
    const { chatId, question, knowledgeBaseId } = req.body;
    if (!question?.trim()) return next(new AppError('Question is required.', 400));

    const company = await Company.findById(req.companyId).select('settings');
    const confidenceThreshold = company?.settings?.confidenceThreshold || 0.3;

    // Get or create chat
    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, companyId: req.companyId, userId: req.user._id });
      if (!chat) return next(new AppError('Conversation not found.', 404));
    } else {
      chat = await Chat.create({
        companyId: req.companyId,
        userId: req.user._id,
        title: question.substring(0, 60),
        knowledgeBaseId: knowledgeBaseId || null,
      });
    }

    // Add user message
    chat.messages.push({ role: 'user', content: question });

    // 1. Embed question (gracefully degrade if embedding service is down)
    let questionEmbedding = null;
    try {
      questionEmbedding = await getEmbedding(question);
    } catch (err) {
      logger.warn('Embedding service unavailable for chat, falling back to keyword-only search');
    }

    // 2. Fetch chunks (scoped to company + optional knowledge base)
    const chunkFilter = { companyId: req.companyId };
    if (knowledgeBaseId || chat.knowledgeBaseId) {
      chunkFilter.knowledgeBaseId = knowledgeBaseId || chat.knowledgeBaseId;
    }
    const allChunks = await DocumentChunk.find(chunkFilter).lean();

    if (allChunks.length === 0) {
      const noDocsMsg = 'No documents found in your knowledge base. Please upload documents first.';
      chat.messages.push({ role: 'assistant', content: noDocsMsg, confidence: 0, sources: [] });
      chat.lastMessageAt = new Date();
      await chat.save();
      return res.status(200).json({
        success: true,
        chatId: chat._id,
        answer: noDocsMsg,
        confidence: 0,
        sources: [],
        citations: [],
      });
    }

    // 3. Hybrid search + rerank
    const searchResults = hybridSearch(allChunks, questionEmbedding, question);
    const reranked = rerankChunks(searchResults, question);

    const topScore = reranked[0]?.rerankScore || 0;

    if (!reranked.length || topScore < 0.05) {
      const notFoundMsg = "I couldn't find sufficient information in your knowledge base to answer that question.";
      chat.messages.push({ role: 'assistant', content: notFoundMsg, confidence: 0, sources: [] });
      chat.lastMessageAt = new Date();
      await chat.save();
      return res.status(200).json({
        success: true,
        chatId: chat._id,
        answer: notFoundMsg,
        confidence: 0,
        sources: [],
        citations: [],
      });
    }

    // 4. Build context
    const topChunks = reranked.slice(0, 5);
    const context = topChunks.map(c => c.chunk).join('\n\n---\n\n');

    // 5. Build conversation history for Groq
    const history = chat.messages.slice(-6).slice(0, -1).map(m => ({
      role: m.role,
      content: m.content,
    }));

    // 6. Generate answer
    const answer = await generateAnswer(context, question, history);

    // 7. Confidence score
    const confidence = Math.min(100, Math.round(topScore * 200));

    // 8. Citations
    const sources = [...new Set(topChunks.map(c => c.source))];
    const citations = topChunks.map((chunk, idx) => ({
      rank: idx + 1,
      document: chunk.source,
      documentId: chunk.documentId,
      score: Number(chunk.rerankScore?.toFixed(3) || chunk.score?.toFixed(3)),
      preview: chunk.chunk.replace(/\n/g, ' ').substring(0, 250) + '...',
    }));

    // 9. Store assistant message
    chat.messages.push({
      role: 'assistant',
      content: answer,
      confidence,
      sources: citations.map(c => ({ document: c.document, score: c.score, preview: c.preview })),
    });
    chat.lastMessageAt = new Date();

    // Auto-title after first exchange
    if (chat.messages.length === 2) {
      chat.title = question.substring(0, 60);
    }

    await chat.save();

    // 10. Update company usage
    await Company.findByIdAndUpdate(req.companyId, { $inc: { 'usage.questionsAsked': 1 } });

    res.status(200).json({
      success: true,
      chatId: chat._id,
      question,
      answer,
      confidence,
      sources,
      citations,
      chunksUsed: topChunks.length,
    });
  } catch (err) {
    next(err);
  }
};

exports.updateChat = async (req, res, next) => {
  try {
    const { title, isArchived } = req.body;
    const chat = await Chat.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId, userId: req.user._id },
      { ...(title && { title }), ...(isArchived !== undefined && { isArchived }) },
      { new: true }
    );
    if (!chat) return next(new AppError('Conversation not found.', 404));
    res.status(200).json({ success: true, data: chat });
  } catch (err) { next(err); }
};

exports.deleteChat = async (req, res, next) => {
  try {
    const chat = await Chat.findOneAndDelete({ _id: req.params.id, companyId: req.companyId, userId: req.user._id });
    if (!chat) return next(new AppError('Conversation not found.', 404));
    res.status(200).json({ success: true, message: 'Conversation deleted.' });
  } catch (err) { next(err); }
};

exports.addFeedback = async (req, res, next) => {
  try {
    const { messageIndex, feedback } = req.body;
    const chat = await Chat.findOne({ _id: req.params.id, companyId: req.companyId, userId: req.user._id });
    if (!chat) return next(new AppError('Conversation not found.', 404));
    if (!chat.messages[messageIndex]) return next(new AppError('Message not found.', 404));

    chat.messages[messageIndex].feedback = feedback;
    await chat.save();
    res.status(200).json({ success: true, message: 'Feedback recorded.' });
  } catch (err) { next(err); }
};