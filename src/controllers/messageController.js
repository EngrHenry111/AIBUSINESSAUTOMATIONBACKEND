'use strict';

const Message = require('../models/Message');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');

// ── GET /messages/team — get all team members with last message + unread count
exports.getTeamConversations = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const companyId = req.companyId;

    // Get all team members excluding self
    const teamMembers = await User.find({
      companyId,
      _id: { $ne: userId },
      status: 'active',
    }).select('name avatar role status lastLogin');

    // For each member, get last message and unread count
    const conversations = await Promise.all(teamMembers.map(async (member) => {
      const [lastMessage, unreadCount] = await Promise.all([
        Message.findOne({
          companyId,
          $or: [
            { senderId: userId, recipientId: member._id },
            { senderId: member._id, recipientId: userId },
          ],
        }).sort({ createdAt: -1 }).select('content createdAt senderId isRead'),

        Message.countDocuments({
          companyId,
          senderId: member._id,
          recipientId: userId,
          isRead: false,
        }),
      ]);

      return {
        user: member,
        lastMessage,
        unreadCount,
      };
    }));

    // Sort by last message time, then by name
    conversations.sort((a, b) => {
      if (a.lastMessage && b.lastMessage) {
        return new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt);
      }
      if (a.lastMessage) return -1;
      if (b.lastMessage) return 1;
      return a.user.name.localeCompare(b.user.name);
    });

    res.status(200).json({ success: true, data: conversations });
  } catch (err) { next(err); }
};

// ── GET /messages/:userId — get conversation with a specific user
exports.getConversation = async (req, res, next) => {
  try {
    const { userId: otherUserId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const myId = req.user._id;
    const companyId = req.companyId;

    // Verify other user is in same company
    const otherUser = await User.findOne({ _id: otherUserId, companyId })
      .select('name avatar role status');
    if (!otherUser) return next(new AppError('User not found.', 404));

    const messages = await Message.find({
      companyId,
      $or: [
        { senderId: myId, recipientId: otherUserId },
        { senderId: otherUserId, recipientId: myId },
      ],
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('senderId', 'name avatar')
      .lean();

    // Mark messages from other user as read
    await Message.updateMany(
      { companyId, senderId: otherUserId, recipientId: myId, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    // Notify via socket that messages were read
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${otherUserId}`).emit('messages:read', {
        byUserId: myId.toString(),
      });
    }

    res.status(200).json({
      success: true,
      data: {
        messages: messages.reverse(), // oldest first
        otherUser,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /messages/:userId — send a message
exports.sendMessage = async (req, res, next) => {
  try {
    const { userId: recipientId } = req.params;
    const { content } = req.body;
    const senderId = req.user._id;
    const companyId = req.companyId;

    if (!content?.trim()) return next(new AppError('Message content is required.', 400));

    const recipient = await User.findOne({ _id: recipientId, companyId });
    if (!recipient) return next(new AppError('Recipient not found.', 404));

    const message = await Message.create({
      companyId,
      senderId,
      recipientId,
      content: content.trim(),
    });

    const populated = await Message.findById(message._id)
      .populate('senderId', 'name avatar');

    // Emit real-time message via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${recipientId}`).emit('message:new', populated);
      io.to(`user:${senderId}`).emit('message:sent', populated);
    }

    res.status(201).json({ success: true, data: populated });
  } catch (err) { next(err); }
};

// ── GET /messages/unread-count — total unread messages for current user
exports.getUnreadCount = async (req, res, next) => {
  try {
    const count = await Message.countDocuments({
      companyId: req.companyId,
      recipientId: req.user._id,
      isRead: false,
    });
    res.status(200).json({ success: true, data: { count } });
  } catch (err) { next(err); }
};

// ── DELETE /messages/:messageId — delete own message
exports.deleteMessage = async (req, res, next) => {
  try {
    const message = await Message.findOne({
      _id: req.params.messageId,
      senderId: req.user._id,
      companyId: req.companyId,
    });
    if (!message) return next(new AppError('Message not found.', 404));

    await message.deleteOne();

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${message.recipientId}`).emit('message:deleted', {
        messageId: req.params.messageId,
      });
    }

    res.status(200).json({ success: true, message: 'Message deleted.' });
  } catch (err) { next(err); }
};
