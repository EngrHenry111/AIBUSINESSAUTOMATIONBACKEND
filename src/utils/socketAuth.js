'use strict';

// Socket.io access control. The browser's session cookie lives on the
// frontend's domain and never reaches the socket server, so a signed-in page
// first fetches a short-lived socket token from the API (GET
// /auth/socket-token) and sends it in the handshake. Rooms are then joined
// from the verified user, never from an id the client chose: a socket can
// only hear its own company and its own direct messages. Sockets without a
// token stay anonymous and may only follow public group-buy pages.
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('./logger');

const SOCKET_TOKEN_TTL = '2m';

function issueSocketToken(user) {
  return jwt.sign(
    { id: String(user._id), tv: user.tokenVersion || 0, purpose: 'socket' },
    process.env.JWT_SECRET,
    { expiresIn: SOCKET_TOKEN_TTL },
  );
}

async function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'socket') return null; // an access token is not a socket token
    const user = await User.findById(decoded.id).select('companyId role status tokenVersion').lean();
    if (!user || user.status !== 'active' || (user.tokenVersion || 0) !== (decoded.tv || 0)) return null;
    return { id: String(user._id), companyId: user.companyId ? String(user.companyId) : null, role: user.role };
  } catch {
    return null;
  }
}

function attachSocketHandlers(io) {
  io.use(async (socket, next) => {
    socket.data.user = await userFromToken(socket.handshake.auth?.token);
    next();
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    logger.debug(`Socket connected: ${socket.id}${user ? ` (user ${user.id})` : ' (anonymous)'}`);

    // The id the client sends is ignored: a member only ever joins the
    // company they belong to.
    const joinOwnCompany = () => {
      if (user?.companyId) socket.join(`company:${user.companyId}`);
    };
    socket.on('join_company', joinOwnCompany);
    socket.on('whatsapp:join', joinOwnCompany);

    socket.on('join_user', () => {
      if (!user) return;
      socket.join(`user:${user.id}`);
      if (user.companyId) socket.to(`company:${user.companyId}`).emit('user:online', { userId: user.id });
    });

    // Public group-buy page: anonymous shoppers follow the participant count.
    socket.on('join_groupbuy', (groupBuyId) => {
      if (typeof groupBuyId === 'string' && /^[a-f0-9]{24}$/i.test(groupBuyId)) socket.join(`groupbuy:${groupBuyId}`);
    });

    // Typing indicators go only to a teammate in the same company.
    const relayTyping = (event) => async ({ toUserId } = {}) => {
      if (!user?.companyId || typeof toUserId !== 'string' || !/^[a-f0-9]{24}$/i.test(toUserId)) return;
      try {
        if (!await User.exists({ _id: toUserId, companyId: user.companyId })) return;
        socket.to(`user:${toUserId}`).emit(event, event === 'typing:start' ? { _id: user.id } : { fromUserId: user.id });
      } catch { /* ignore */ }
    };
    socket.on('typing:start', relayTyping('typing:start'));
    socket.on('typing:stop', relayTyping('typing:stop'));

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
      if (user?.companyId) io.to(`company:${user.companyId}`).emit('user:offline', { userId: user.id });
    });
  });
}

module.exports = { issueSocketToken, userFromToken, attachSocketHandlers };
