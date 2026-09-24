'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const GroupBuy = require('../models/GroupBuy');
const Product = require('../models/Product');
const Company = require('../models/Company');
const User = require('../models/User');
const { AppError } = require('../middleware/errorMiddleware');
const { paystackAPI } = require('../utils/paystack');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// findStore/finalizePlacedOrder/nextOrderNumber live in storefrontController —
// required lazily to avoid a require cycle at module load, same pattern
// giftCardController and storeSubscriptionController already use.
function sc() { return require('./storefrontController'); }

// GB-XXXX, unique per company.
async function generateShareCode(companyId) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `GB-${Array.from(crypto.randomBytes(4)).map((b) => alphabet[b % alphabet.length]).join('')}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await GroupBuy.exists({ companyId, shareCode: code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique share code.');
}

function timeRemaining(endDate) {
  const ms = Math.max(0, new Date(endDate).getTime() - Date.now());
  return { ms, expired: ms <= 0 };
}

// Public shape — never leaks participants' emails/phones/references, per the
// spec's "does NOT show other participants' details".
function publicGroupBuy(gb) {
  const { expired, ms } = timeRemaining(gb.endDate);
  return {
    _id: gb._id, // opaque id only, needed client-side to join the live-update socket room
    shareCode: gb.shareCode,
    title: gb.title,
    description: gb.description,
    productName: gb.productName,
    productImage: gb.productImage,
    originalPrice: gb.originalPrice,
    groupPrice: gb.groupPrice,
    discountPercent: gb.discountPercent,
    minimumParticipants: gb.minimumParticipants,
    maximumParticipants: gb.maximumParticipants,
    currentParticipants: gb.currentParticipants,
    remainingToUnlock: Math.max(0, gb.minimumParticipants - gb.currentParticipants),
    status: gb.status,
    endDate: gb.endDate,
    msRemaining: ms,
    expired,
    isFull: Boolean(gb.maximumParticipants) && gb.currentParticipants >= gb.maximumParticipants,
  };
}

// ── POST /group-buys (protected) ────────────────────────────────────────────
exports.createGroupBuy = async (req, res, next) => {
  try {
    const { productId, title, description, groupPrice, minimumParticipants, maximumParticipants, endDate } = req.body;

    const product = await Product.findOne({ _id: productId, companyId: req.companyId });
    if (!product) return next(new AppError('Product not found.', 404));
    if (!groupPrice || Number(groupPrice) <= 0 || Number(groupPrice) >= product.price) {
      return next(new AppError('Group price must be lower than the regular price.', 400));
    }
    const minP = Math.max(2, parseInt(minimumParticipants, 10) || 0);
    if (!minP) return next(new AppError('Minimum participants must be at least 2.', 400));
    const maxP = maximumParticipants ? Math.max(minP, parseInt(maximumParticipants, 10)) : null;
    const deadline = new Date(endDate);
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) {
      return next(new AppError('Deadline must be a valid future date.', 400));
    }

    const company = await Company.findById(req.companyId).select('storeSlug');
    const shareCode = await generateShareCode(req.companyId);
    const discountPercent = Math.round((1 - Number(groupPrice) / product.price) * 100);

    const groupBuy = await GroupBuy.create({
      companyId: req.companyId,
      productId: product._id,
      productName: product.name,
      productImage: product.images?.[0],
      title: title?.trim() || `Group Buy: ${product.name}`,
      description: description?.trim(),
      originalPrice: product.price,
      groupPrice: Number(groupPrice),
      discountPercent,
      minimumParticipants: minP,
      maximumParticipants: maxP,
      endDate: deadline,
      shareCode,
      shareLink: `${clientUrl()}/store/${company.storeSlug}/group/${shareCode}`,
    });

    res.status(201).json({ success: true, data: groupBuy });
  } catch (err) { next(err); }
};

// ── GET /group-buys (protected) ─────────────────────────────────────────────
exports.getGroupBuys = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;

    const [groupBuys, statusCounts] = await Promise.all([
      GroupBuy.find(filter).sort({ createdAt: -1 }),
      GroupBuy.aggregate([
        { $match: { companyId: req.companyId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);
    const counts = Object.fromEntries(statusCounts.map((c) => [c._id, c.count]));

    res.status(200).json({
      success: true,
      data: groupBuys,
      stats: { active: counts.active || 0, successful: counts.successful || 0, failed: counts.failed || 0, cancelled: counts.cancelled || 0 },
    });
  } catch (err) { next(err); }
};

// ── DELETE /group-buys/:id (protected) ──────────────────────────────────────
exports.cancelGroupBuy = async (req, res, next) => {
  try {
    const groupBuy = await GroupBuy.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!groupBuy) return next(new AppError('Group buy not found.', 404));
    if (!['active'].includes(groupBuy.status)) return next(new AppError('Only an active group buy can be cancelled.', 400));

    const company = await Company.findById(req.companyId);
    for (const p of groupBuy.participants) {
      if (p.paymentStatus === 'paid') {
        // eslint-disable-next-line no-await-in-loop
        await refundParticipant(company, groupBuy, p, 'cancelled');
      }
    }
    groupBuy.status = 'cancelled';
    groupBuy.cancelledAt = new Date();
    await groupBuy.save();

    res.status(200).json({ success: true, message: 'Group buy cancelled and any paid participants refunded.' });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/group-buys/:shareCode (public) ─────────────────────────
// ── GET /store/:slug/group-buys (public) ────────────────────────────────────
// Not in the original spec's route list, but needed for Store.jsx's "🔥
// Limited Time Group Deals" section, which has to know which deals are
// active without the shopper already having a specific share link.
exports.getPublicGroupBuys = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug);
    const groupBuys = await GroupBuy.find({ companyId: company._id, status: 'active', endDate: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(20);
    res.status(200).json({ success: true, data: groupBuys.map(publicGroupBuy) });
  } catch (err) { next(err); }
};

exports.getPublicGroupBuy = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug);
    const groupBuy = await GroupBuy.findOne({ companyId: company._id, shareCode: req.params.shareCode.toUpperCase() });
    if (!groupBuy) return next(new AppError('This group buy was not found.', 404));

    res.status(200).json({ success: true, data: publicGroupBuy(groupBuy) });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/group-buys/:shareCode/join (public) ──────────────────
exports.joinGroupBuy = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug, { requirePayments: true });
    const groupBuy = await GroupBuy.findOne({ companyId: company._id, shareCode: req.params.shareCode.toUpperCase() });
    if (!groupBuy) return next(new AppError('This group buy was not found.', 404));
    if (groupBuy.status !== 'active') return next(new AppError('This group buy is no longer accepting participants.', 400));
    if (timeRemaining(groupBuy.endDate).expired) return next(new AppError('This group buy has expired.', 400));
    if (groupBuy.maximumParticipants && groupBuy.currentParticipants >= groupBuy.maximumParticipants) {
      return next(new AppError('This group buy is full.', 400));
    }

    const { name, email, phone, quantity = 1 } = req.body;
    if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '')) return next(new AppError('A valid name and email are required.', 400));
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const amount = Math.round(groupBuy.groupPrice * qty * 100) / 100;

    // Paystack has no "authorize now, capture later" primitive for a
    // standard transaction — a successful card charge here IS a real,
    // immediate capture. The "payment held safely" promise to the shopper
    // is honored via a real refund (see refundParticipant) if the group
    // fails to reach its minimum by the deadline, not a delayed capture.
    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email,
      amount: Math.round(amount * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: {
        type: 'group_buy_join', companyId: String(company._id), slug: company.storeSlug,
        groupBuyId: String(groupBuy._id), shareCode: groupBuy.shareCode,
        name: String(name).slice(0, 120), phone: phone ? String(phone).slice(0, 40) : undefined, quantity: qty,
      },
      callback_url: `${clientUrl()}/store/${company.storeSlug}/group/${groupBuy.shareCode}?ref={reference}`,
    });
    if (!initRes.status) throw new AppError('Could not start checkout. Please try again.', 502);

    res.status(200).json({ success: true, data: { authorizationUrl: initRes.data.authorization_url, reference: initRes.data.reference, amount } });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/group-buys/:shareCode/verify (public) ────────────────
exports.verifyGroupBuyPayment = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug);
    const groupBuy = await GroupBuy.findOne({ companyId: company._id, shareCode: req.params.shareCode.toUpperCase() });
    if (!groupBuy) return next(new AppError('This group buy was not found.', 404));

    const { reference } = req.body;
    if (!reference) return next(new AppError('A payment reference is required.', 400));

    const already = groupBuy.participants.find((p) => p.paystackReference === reference);
    if (already) return res.status(200).json({ success: true, data: publicGroupBuy(groupBuy) });

    const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!vr.status || vr.data?.status !== 'success') return next(new AppError('Payment has not been completed.', 400));
    const meta = vr.data.metadata || {};
    if (String(meta.companyId) !== String(company._id) || meta.type !== 'group_buy_join' || String(meta.groupBuyId) !== String(groupBuy._id)) {
      return next(new AppError('This payment does not belong to this group buy.', 400));
    }
    if (groupBuy.status !== 'active') {
      return next(new AppError('This group buy is no longer active — your payment was not charged twice; contact the store about a refund.', 400));
    }

    const amount = (vr.data.amount || 0) / 100;
    groupBuy.participants.push({
      name: meta.name, email: vr.data.customer?.email, phone: meta.phone, quantity: meta.quantity || 1,
      amount, paymentStatus: 'paid', paystackReference: reference, joinedAt: new Date(),
    });
    groupBuy.currentParticipants += 1;
    groupBuy.totalValue = Math.round((groupBuy.totalValue + amount) * 100) / 100;

    const reachedMinimum = groupBuy.currentParticipants >= groupBuy.minimumParticipants;
    if (reachedMinimum) {
      groupBuy.status = 'successful';
      groupBuy.successfulAt = new Date();
    }
    await groupBuy.save();

    const io = req.app.get('io');
    io?.to(`groupbuy:${groupBuy._id}`).emit('groupbuy:update', {
      currentParticipants: groupBuy.currentParticipants, minimumParticipants: groupBuy.minimumParticipants,
      status: groupBuy.status, joinedName: String(meta.name || '').split(' ')[0] || 'Someone',
    });
    io?.to(`company:${company._id}`).emit('notification:refresh', { type: 'group_buy_joined', shareCode: groupBuy.shareCode });

    // "You joined!" email — sent regardless of whether the group already hit
    // its minimum, since finalizeSuccessfulGroupBuy sends its own separate
    // "you got the deal" email once orders are created.
    emailService.send({
      to: groupBuy.participants[groupBuy.participants.length - 1].email,
      subject: `You joined the group buy for ${groupBuy.productName}!`,
      html: emailService.baseTemplate('You joined!', `
        <h2 style="color:#0f172a;margin:0 0 6px;">You're in! 🎉</h2>
        <p style="color:#475569;font-size:14px;">You joined the group buy for <strong>${groupBuy.productName}</strong> at ${naira(groupBuy.groupPrice)} each.</p>
        ${reachedMinimum
          ? `<p style="color:#475569;font-size:14px;">The deal has already unlocked — your order is being processed!</p>`
          : `<p style="color:#475569;font-size:14px;">${groupBuy.minimumParticipants - groupBuy.currentParticipants} more people need to join before ${new Date(groupBuy.endDate).toLocaleString()} to unlock the deal. Share your link to help it along:</p>
             <p style="text-align:center;margin:20px 0;"><a href="${company.storeSlug ? `${clientUrl()}/store/${company.storeSlug}/group/${groupBuy.shareCode}` : '#'}" style="background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Share the deal</a></p>
             <p style="color:#94a3b8;font-size:12px;">If the deal doesn't unlock by the deadline, you'll be refunded in full automatically.</p>`}
      `, { name: company.companyName, logo: company.logo }),
    }).catch((e) => logger.warn(`Group buy join email failed: ${e.message}`));

    if (reachedMinimum) {
      await finalizeSuccessfulGroupBuy(company, groupBuy, io);
    }

    res.status(reachedMinimum ? 201 : 200).json({ success: true, data: publicGroupBuy(groupBuy) });
  } catch (err) { next(err); }
};

// ── GET /store/:slug/group-buys/:shareCode/share (public) ──────────────────
exports.shareGroupBuy = async (req, res, next) => {
  try {
    const company = await sc().findStore(req.params.slug);
    const groupBuy = await GroupBuy.findOne({ companyId: company._id, shareCode: req.params.shareCode.toUpperCase() });
    if (!groupBuy) return next(new AppError('This group buy was not found.', 404));

    const link = groupBuy.shareLink || `${clientUrl()}/store/${company.storeSlug}/group/${groupBuy.shareCode}`;
    const remaining = Math.max(0, groupBuy.minimumParticipants - groupBuy.currentParticipants);
    const whatsappMessage = `🛍️ Join me in this group buy deal!\nGet ${groupBuy.productName} for just ${naira(groupBuy.groupPrice)} (normally ${naira(groupBuy.originalPrice)}) — save ${groupBuy.discountPercent}%!\n\nWe need ${remaining} more people to unlock this deal before ${new Date(groupBuy.endDate).toLocaleString()}.\n\nJoin here: ${link}\n\nHurry — deal expires soon! ⏰`;
    const socialText = `🔥 Group Buy: ${groupBuy.productName} for ${naira(groupBuy.groupPrice)} (save ${groupBuy.discountPercent}%) — join before it expires! ${link}`;
    const qrCode = await QRCode.toDataURL(link);

    res.status(200).json({
      success: true,
      data: {
        link,
        whatsappUrl: `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsappMessage)}`,
        whatsappMessage, socialText, qrCode,
      },
    });
  } catch (err) { next(err); }
};

// ── Success: create every participant's order, email them, notify owner ────
async function finalizeSuccessfulGroupBuy(company, groupBuy, io) {
  let ordersCreated = 0;
  for (const p of groupBuy.participants) {
    if (p.paymentStatus !== 'paid' || p.orderId) continue; // already fulfilled or never paid
    try {
      // eslint-disable-next-line no-await-in-loop
      const orderNumber = await sc().nextOrderNumber(company._id);
      const Order = require('../models/Order');
      // eslint-disable-next-line no-await-in-loop
      const order = await Order.create({
        companyId: company._id,
        orderNumber,
        source: 'storefront',
        paystackReference: p.paystackReference,
        customer: { name: p.name, email: p.email, phone: p.phone },
        items: [{ productId: groupBuy.productId, name: groupBuy.productName, image: groupBuy.productImage, quantity: p.quantity, price: groupBuy.groupPrice }],
        subtotal: p.amount, deliveryFee: 0, total: p.amount, currency: 'NGN',
        paymentMethod: 'paystack', status: 'confirmed', paymentStatus: 'paid',
        notes: `Group buy — ${groupBuy.title}`,
        stockApplied: false,
        timeline: [{ status: 'confirmed', description: `Group buy unlocked — ${groupBuy.title}`, timestamp: new Date() }],
      });
      // eslint-disable-next-line no-await-in-loop
      await sc().finalizePlacedOrder(company, order, { io });
      p.orderId = order._id;
      ordersCreated += 1;

      emailService.send({
        to: p.email,
        subject: `🎉 Deal unlocked! ${groupBuy.productName} is on its way`,
        html: emailService.baseTemplate('Deal unlocked!', `
          <h2 style="color:#0f172a;margin:0 0 6px;">The group buy succeeded! 🎉</h2>
          <p style="color:#475569;font-size:14px;">Enough people joined the <strong>${groupBuy.title}</strong> deal — your order <strong>${order.orderNumber}</strong> for ${naira(p.amount)} has been placed.</p>
        `, { name: company.companyName, logo: company.logo }),
      }).catch((e) => logger.warn(`Group buy success email failed for ${p.email}: ${e.message}`));
    } catch (e) {
      logger.error(`Group buy order creation failed for participant ${p.email}: ${e.message}`);
    }
  }
  await groupBuy.save();

  const owner = await User.findById(company.owner).select('email');
  if (owner?.email) {
    emailService.send({
      to: owner.email,
      subject: `Group buy succeeded — ${groupBuy.title}`,
      html: emailService.baseTemplate('Group buy succeeded', `
        <h2 style="color:#0f172a;margin:0 0 6px;">A group buy just unlocked! 🎉</h2>
        <p style="color:#475569;font-size:14px;">${groupBuy.currentParticipants} people joined <strong>${groupBuy.title}</strong>. ${ordersCreated} order(s) worth ${naira(groupBuy.totalValue)} were created automatically.</p>
      `, { name: company.companyName, logo: company.logo }),
    }).catch(() => {});
  }

  io?.to(`groupbuy:${groupBuy._id}`).emit('groupbuy:update', { status: 'successful', currentParticipants: groupBuy.currentParticipants, minimumParticipants: groupBuy.minimumParticipants });
}

// ── Refund a single participant via a real Paystack refund ─────────────────
async function refundParticipant(company, groupBuy, participant, reason) {
  try {
    if (participant.paymentStatus !== 'paid') return;
    await paystackAPI('POST', '/refund', { transaction: participant.paystackReference });
    participant.paymentStatus = 'refunded';

    emailService.send({
      to: participant.email,
      subject: reason === 'cancelled' ? `Group buy cancelled — you've been refunded` : `Group buy didn't unlock — you've been refunded`,
      html: emailService.baseTemplate('Refund processed', `
        <h2 style="color:#0f172a;margin:0 0 6px;">Your ${naira(participant.amount)} has been refunded</h2>
        <p style="color:#475569;font-size:14px;">
          ${reason === 'cancelled'
            ? `The group buy for <strong>${groupBuy.productName}</strong> was cancelled by the store.`
            : `Not enough people joined the group buy for <strong>${groupBuy.productName}</strong> before the deadline, so it didn't unlock.`}
        </p>
        <p style="color:#94a3b8;font-size:12px;">Refunds are processed by Paystack and typically reflect on your card or account within 3–5 business days.</p>
      `, { name: company.companyName, logo: company.logo }),
    }).catch((e) => logger.warn(`Group buy refund email failed for ${participant.email}: ${e.message}`));
  } catch (err) {
    logger.error(`Group buy refund failed for ${participant.email} (${participant.paystackReference}): ${err.message}`);
  }
}

// ── Hourly job: settle every group buy whose deadline has passed ───────────
exports.checkExpiredGroupBuys = async () => {
  try {
    const expired = await GroupBuy.find({ status: 'active', endDate: { $lte: new Date() } });
    if (!expired.length) return;
    logger.warn(`Settling ${expired.length} expired group buy(s)`);

    for (const groupBuy of expired) {
      // eslint-disable-next-line no-await-in-loop
      const company = await Company.findById(groupBuy.companyId);
      if (!company) continue;
      const io = global.io;

      if (groupBuy.currentParticipants >= groupBuy.minimumParticipants) {
        // Should already have been finalized at the moment it hit its
        // minimum (see verifyGroupBuyPayment) — this only catches a group
        // buy that reached the minimum exactly as the deadline passed.
        groupBuy.status = 'successful';
        groupBuy.successfulAt = new Date();
        // eslint-disable-next-line no-await-in-loop
        await groupBuy.save();
        // eslint-disable-next-line no-await-in-loop
        await finalizeSuccessfulGroupBuy(company, groupBuy, io);
      } else {
        groupBuy.status = 'failed';
        groupBuy.failedAt = new Date();
        for (const p of groupBuy.participants) {
          // eslint-disable-next-line no-await-in-loop
          await refundParticipant(company, groupBuy, p, 'failed');
        }
        // eslint-disable-next-line no-await-in-loop
        await groupBuy.save();
        io?.to(`groupbuy:${groupBuy._id}`).emit('groupbuy:update', { status: 'failed', currentParticipants: groupBuy.currentParticipants, minimumParticipants: groupBuy.minimumParticipants });
      }
    }
  } catch (err) {
    logger.error(`checkExpiredGroupBuys failed: ${err.message}`);
  }
};
