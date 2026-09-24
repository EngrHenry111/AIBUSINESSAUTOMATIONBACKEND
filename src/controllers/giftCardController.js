'use strict';

const crypto = require('crypto');
const GiftCard = require('../models/GiftCard');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { paystackAPI } = require('../utils/paystack');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// findStore lives in storefrontController — reused here rather than
// duplicated so both controllers resolve "is this a real, enabled store"
// identically (required lazily to avoid a require cycle at module load).
function findStore(slug, opts) {
  return require('./storefrontController').findStore(slug, opts);
}

// BIZLY-XXXX-XXXX-XXXX, uppercase alphanumeric, checked for uniqueness.
async function generateGiftCardCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to misread
  const randomBlock = () => Array.from(crypto.randomBytes(4)).map((b) => alphabet[b % alphabet.length]).join('');
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `BIZLY-${randomBlock()}-${randomBlock()}-${randomBlock()}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await GiftCard.exists({ code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique gift card code.');
}

// ── POST /store/:slug/gift-cards/purchase ───────────────────────────────────
exports.purchaseGiftCard = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug, { requirePayments: true });
    const gcs = company.giftCardSettings || {};
    if (gcs.enabled === false) return next(new AppError('Gift cards are not available for this store.', 400));

    const { amount, recipientName, recipientEmail, recipientMessage, buyerName, buyerEmail, buyerPhone, scheduledSendAt } = req.body;
    const numAmount = Number(amount);
    const min = gcs.minAmount ?? 500;
    const max = gcs.maxAmount ?? 500000;
    if (!numAmount || numAmount < min || numAmount > max) {
      return next(new AppError(`Gift card amount must be between ${naira(min)} and ${naira(max)}.`, 400));
    }
    if (!recipientName?.trim() || !/^\S+@\S+\.\S+$/.test(recipientEmail || '')) {
      return next(new AppError('A valid recipient name and email are required.', 400));
    }
    if (!buyerName?.trim() || !/^\S+@\S+\.\S+$/.test(buyerEmail || '')) {
      return next(new AppError('A valid buyer name and email are required.', 400));
    }
    if (recipientMessage && recipientMessage.length > 200) {
      return next(new AppError('Personal message must be 200 characters or fewer.', 400));
    }

    // Routed through the store's own Paystack subaccount, same as a regular
    // order — BizlyAI's commission is taken automatically by the split,
    // never a separate charge here.
    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email: buyerEmail,
      amount: Math.round(numAmount * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: {
        type: 'gift_card_purchase',
        companyId: String(company._id),
        slug: company.storeSlug,
        amount: numAmount,
        recipientName: String(recipientName).slice(0, 120),
        recipientEmail,
        recipientMessage: recipientMessage ? String(recipientMessage).slice(0, 200) : undefined,
        buyerName: String(buyerName).slice(0, 120),
        buyerEmail,
        buyerPhone: buyerPhone ? String(buyerPhone).slice(0, 40) : undefined,
        scheduledSendAt: scheduledSendAt || undefined,
      },
      callback_url: `${clientUrl()}/store/${company.storeSlug}/gift-card?ref={reference}`,
    });

    if (!initRes.status) throw new AppError('Could not start gift card checkout. Please try again.', 502);

    res.status(200).json({ success: true, data: { authorizationUrl: initRes.data.authorization_url, reference: initRes.data.reference } });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/gift-cards/verify ─────────────────────────────────────
exports.verifyGiftCardPurchase = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const { reference } = req.body;
    if (!reference) return next(new AppError('A payment reference is required.', 400));

    const existing = await GiftCard.findOne({ paystackReference: reference, companyId: company._id });
    if (existing) return res.status(200).json({ success: true, data: { giftCard: publicGiftCard(existing) } });

    const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!vr.status || vr.data?.status !== 'success') return next(new AppError('Payment has not been completed.', 400));
    const meta = vr.data.metadata || {};
    if (String(meta.companyId) !== String(company._id) || meta.type !== 'gift_card_purchase') {
      return next(new AppError('This payment does not belong to this store.', 400));
    }

    const code = await generateGiftCardCode();
    const expiresAt = new Date(Date.now() + (company.giftCardSettings?.expiryDays ?? 365) * 24 * 60 * 60 * 1000);
    const scheduledSendAt = meta.scheduledSendAt ? new Date(meta.scheduledSendAt) : null;
    const sendNow = !scheduledSendAt || scheduledSendAt <= new Date();

    let giftCard;
    try {
      giftCard = await GiftCard.create({
        companyId: company._id,
        code,
        amount: meta.amount,
        balance: meta.amount,
        currency: 'NGN',
        purchasedBy: { name: meta.buyerName, email: meta.buyerEmail, phone: meta.buyerPhone },
        sentTo: { name: meta.recipientName, email: meta.recipientEmail, message: meta.recipientMessage },
        scheduledSendAt: scheduledSendAt || undefined,
        sentAt: sendNow ? new Date() : undefined,
        expiresAt,
        paystackReference: reference,
      });
    } catch (err) {
      if (err.code === 11000) {
        const again = await GiftCard.findOne({ paystackReference: reference });
        if (again) return res.status(200).json({ success: true, data: { giftCard: publicGiftCard(again) } });
      }
      throw err;
    }

    if (sendNow) {
      emailService.sendGiftCardEmail({
        to: giftCard.sentTo.email, recipientName: giftCard.sentTo.name, buyerName: giftCard.purchasedBy.name,
        message: giftCard.sentTo.message, code: giftCard.code, amount: giftCard.amount, currency: giftCard.currency,
        storeName: company.companyName, storeLogo: company.logo, storeUrl: `${clientUrl()}/store/${company.storeSlug}`,
        expiresAt: giftCard.expiresAt,
      }).catch((e) => logger.warn(`Gift card recipient email failed: ${e.message}`));
    }

    emailService.send({
      to: giftCard.purchasedBy.email,
      subject: `Gift card sent to ${giftCard.sentTo.name} — ${naira(giftCard.amount)}`,
      html: emailService.baseTemplate('Gift Card Purchased', `
        <h2 style="color:#0f172a;margin:0 0 6px;">Your gift card is on its way! 🎉</h2>
        <p style="color:#475569;font-size:14px;">You purchased a <strong>${naira(giftCard.amount)}</strong> gift card for <strong>${giftCard.sentTo.name}</strong> at ${company.companyName}.</p>
        <p style="color:#475569;font-size:14px;">${sendNow ? `It's been emailed to ${giftCard.sentTo.email}.` : `It will be delivered on ${new Date(scheduledSendAt).toLocaleDateString()}.`}</p>
        <p style="color:#94a3b8;font-size:12px;margin-top:16px;">Gift card code (for your records): ${giftCard.code}</p>
      `, { name: company.companyName, logo: company.logo }),
    }).catch((e) => logger.warn(`Gift card buyer confirmation failed: ${e.message}`));

    res.status(201).json({ success: true, data: { giftCard: publicGiftCard(giftCard) } });
  } catch (err) { next(err); }
};

// ── POST /store/:slug/gift-cards/validate ───────────────────────────────────
exports.validateGiftCard = async (req, res, next) => {
  try {
    const company = await findStore(req.params.slug);
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return next(new AppError('Enter a gift card code.', 400));

    const giftCard = await GiftCard.findOne({ companyId: company._id, code });
    if (!giftCard) return res.status(200).json({ success: true, data: { valid: false, message: 'Gift card not found.' } });
    if (giftCard.status === 'cancelled') return res.status(200).json({ success: true, data: { valid: false, message: 'This gift card has been cancelled.' } });
    if (giftCard.status === 'used' || giftCard.balance <= 0) return res.status(200).json({ success: true, data: { valid: false, message: 'This gift card has already been fully redeemed.' } });
    if (giftCard.expiresAt < new Date()) return res.status(200).json({ success: true, data: { valid: false, message: 'This gift card has expired.' } });

    res.status(200).json({ success: true, data: { valid: true, balance: giftCard.balance, currency: giftCard.currency, expiresAt: giftCard.expiresAt } });
  } catch (err) { next(err); }
};

// Server-authoritative redemption — never called with a client-supplied
// amount. Invoked from storefrontController.finalizePlacedOrder with the
// exact figure that was already deducted from the order total at
// initialization time. Never throws (mirrors deductPointsFromCustomer) —
// a redemption failure here must not undo an order that's already placed.
async function redeemGiftCardForOrder(companyId, code, amount, order) {
  try {
    if (!code || !amount) return null;
    const giftCard = await GiftCard.findOne({ companyId, code: String(code).trim().toUpperCase() });
    if (!giftCard || giftCard.status !== 'active' || giftCard.balance < amount) {
      logger.warn(`Gift card redemption skipped for order ${order.orderNumber}: invalid or insufficient balance on ${code}`);
      return null;
    }
    giftCard.balance = Math.round((giftCard.balance - amount) * 100) / 100;
    giftCard.redemptions.push({ orderId: order._id, amount, redeemedAt: new Date() });
    giftCard.redeemedBy = { name: order.customer?.name, email: order.customer?.email, orderId: order._id };
    if (!giftCard.redeemedAt) giftCard.redeemedAt = new Date();
    if (giftCard.balance <= 0) giftCard.status = 'used';
    await giftCard.save();
    return giftCard;
  } catch (err) {
    logger.warn(`Gift card redemption failed for order ${order.orderNumber}: ${err.message}`);
    return null;
  }
}
exports.redeemGiftCardForOrder = redeemGiftCardForOrder;

// ── GET /gift-cards (protected, inside the app) ─────────────────────────────
exports.getStoreGiftCards = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;

    const [giftCards, total, statsAgg] = await Promise.all([
      GiftCard.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      GiftCard.countDocuments(filter),
      GiftCard.aggregate([
        { $match: { companyId: req.companyId } },
        { $group: {
          _id: null,
          sold: { $sum: '$amount' },
          redeemed: { $sum: { $subtract: ['$amount', '$balance'] } },
          outstanding: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, '$balance', 0] } },
          count: { $sum: 1 },
        } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: giftCards,
      stats: {
        sold: statsAgg[0]?.sold || 0, redeemed: statsAgg[0]?.redeemed || 0,
        outstanding: statsAgg[0]?.outstanding || 0, count: statsAgg[0]?.count || 0,
      },
      pagination: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) { next(err); }
};

// Public shape — never leaks companyId, purchasedBy.phone, or redemptions.
function publicGiftCard(gc) {
  return {
    code: gc.code, amount: gc.amount, balance: gc.balance, currency: gc.currency, status: gc.status,
    sentTo: { name: gc.sentTo?.name, email: gc.sentTo?.email }, expiresAt: gc.expiresAt, purchasedAt: gc.purchasedAt,
  };
}

// ── Hourly job: send gift cards whose scheduled delivery time has arrived ──
exports.sendScheduledGiftCards = async () => {
  try {
    const due = await GiftCard.find({ scheduledSendAt: { $lte: new Date() }, sentAt: { $exists: false } }).limit(200);
    if (!due.length) return;
    let sent = 0;
    for (const gc of due) {
      // eslint-disable-next-line no-await-in-loop
      const company = await Company.findById(gc.companyId).select('companyName logo storeSlug');
      if (!company) continue;
      // eslint-disable-next-line no-await-in-loop
      await emailService.sendGiftCardEmail({
        to: gc.sentTo.email, recipientName: gc.sentTo.name, buyerName: gc.purchasedBy.name, message: gc.sentTo.message,
        code: gc.code, amount: gc.amount, currency: gc.currency, storeName: company.companyName, storeLogo: company.logo,
        storeUrl: `${clientUrl()}/store/${company.storeSlug}`, expiresAt: gc.expiresAt,
      }).catch((e) => logger.warn(`Scheduled gift card email failed for ${gc.code}: ${e.message}`));
      gc.sentAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await gc.save();
      sent += 1;
    }
    if (sent) logger.warn(`Sent ${sent} scheduled gift card(s).`);
  } catch (err) {
    logger.error(`sendScheduledGiftCards failed: ${err.message}`);
  }
};
