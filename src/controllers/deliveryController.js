'use strict';

const crypto = require('crypto');
const Shipment = require('../models/Shipment');
const Order = require('../models/Order');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const deliveryService = require('../services/deliveryService');
const { PROVIDERS } = deliveryService;
const emailService = require('../services/emailService');
const { sendSMS } = require('../services/smsService');
const { awardLoyaltyForOrder } = require('./orderController');
const logger = require('../utils/logger');

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

// Shipment status -> what it means for the underlying Order. Only the two
// unambiguous ends of the journey touch Order.status; 'failed'/'returned'
// are left for a human to decide what to do next rather than silently
// reverting a shipped order.
const ORDER_STATUS_FOR_SHIPMENT = { picked_up: 'processing', in_transit: 'shipped', out_for_delivery: 'shipped', delivered: 'delivered' };

const STATUS_COPY = {
  picked_up: { subject: 'Your order has been picked up', text: (n) => `Your order ${n} has been picked up by the courier and is on its way.` },
  in_transit: { subject: 'Your order is in transit', text: (n) => `Your order ${n} is in transit.` },
  out_for_delivery: { subject: 'Your order is out for delivery!', text: (n) => `Your order ${n} is out for delivery today!` },
  delivered: { subject: 'Your order has been delivered!', text: (n) => `Your order ${n} has been delivered. Thanks for shopping with us!` },
  failed: { subject: 'Delivery attempt failed', text: (n) => `We attempted to deliver order ${n} but it was unsuccessful. We'll be in touch about next steps.` },
  returned: { subject: 'Your order was returned', text: (n) => `Order ${n} is being returned to the sender.` },
};

// ── GET /delivery/providers (protected) ─────────────────────────────────────
exports.getProviders = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('+deliverySettings.providers.gig.apiKey +deliverySettings.providers.kwik.apiKey +deliverySettings.providers.sendbox.apiKey');
    const providers = Object.entries(PROVIDERS).map(([key, p]) => ({
      key, name: p.name, verified: p.verified,
      configured: deliveryService.isConfigured(company, key),
      connected: Boolean(company.deliverySettings?.providers?.[key]?.connected),
    }));
    providers.push({ key: 'manual', name: 'Manual Tracking', verified: true, configured: true, connected: true });
    res.status(200).json({ success: true, data: { providers, defaultProvider: company.deliverySettings?.defaultProvider || 'manual' } });
  } catch (err) { next(err); }
};

// ── POST /delivery/quote (protected) ────────────────────────────────────────
exports.getQuote = async (req, res, next) => {
  try {
    const { provider = 'manual', from, to, weight } = req.body;
    const company = await Company.findById(req.companyId).select('+deliverySettings.providers.gig.apiKey +deliverySettings.providers.kwik.apiKey +deliverySettings.providers.sendbox.apiKey');
    const quote = await deliveryService.getDeliveryQuote(provider, company, { senderAddress: from, recipientAddress: to, weight });
    res.status(200).json({ success: true, data: quote });
  } catch (err) { next(err); }
};

// ── POST /delivery/shipments (protected) ────────────────────────────────────
exports.createShipment = async (req, res, next) => {
  try {
    const { orderId, provider = 'manual', weight, dimensions, trackingNumber: manualTrackingNumber, estimatedDays, notes } = req.body;
    const order = await Order.findOne({ _id: orderId, companyId: req.companyId });
    if (!order) return next(new AppError('Order not found.', 404));
    if (order.shipmentId) return next(new AppError('This order already has a shipment.', 400));

    const company = await Company.findById(req.companyId).select('+deliverySettings.providers.gig.apiKey +deliverySettings.providers.kwik.apiKey +deliverySettings.providers.sendbox.apiKey companyName profile');
    if (provider !== 'manual' && !deliveryService.isConfigured(company, provider)) {
      return next(new AppError(`${PROVIDERS[provider]?.name || provider} is not connected for this store. Use manual tracking or connect it in Settings.`, 400));
    }
    if (provider === 'manual' && !manualTrackingNumber?.trim()) {
      return next(new AppError('A tracking number is required for manual shipments.', 400));
    }

    const sender = {
      name: company.companyName, phone: company.profile?.phone,
      address: company.profile?.address, city: undefined, state: undefined,
    };
    const recipient = {
      name: order.customer?.name, phone: order.customer?.phone,
      address: order.shippingAddress?.street || order.customer?.address,
      city: order.shippingAddress?.city || order.customer?.city, state: order.shippingAddress?.state || order.customer?.state,
    };

    let result;
    try {
      result = provider === 'manual'
        ? await deliveryService.createManualShipment({ trackingNumber: manualTrackingNumber.trim(), estimatedDays: estimatedDays || company.deliverySettings?.estimatedDeliveryDays })
        : await deliveryService.createShipment(provider, company, {
          senderName: sender.name, senderPhone: sender.phone, senderAddress: sender.address,
          recipientName: recipient.name, recipientPhone: recipient.phone, recipientAddress: recipient.address,
          items: order.items, weight: weight || 1, value: order.total,
        });
    } catch (err) {
      return next(err);
    }

    const existingTrackingNumber = await Shipment.findOne({ trackingNumber: result.trackingNumber });
    if (existingTrackingNumber) return next(new AppError('That tracking number is already in use.', 409));

    const shipment = await Shipment.create({
      companyId: req.companyId, orderId: order._id, provider, providerName: PROVIDERS[provider]?.name || 'Manual',
      trackingNumber: result.trackingNumber, trackingUrl: result.trackingUrl,
      sender, recipient, weight, dimensions, deliveryFee: result.fee ?? undefined,
      estimatedDelivery: result.estimatedDelivery, providerShipmentId: result.providerShipmentId, notes,
      trackingHistory: [{ status: 'pending', description: 'Shipment created', timestamp: new Date() }],
    });

    order.shipmentId = shipment._id;
    order.trackingNumber = shipment.trackingNumber;
    order.trackingUrl = shipment.trackingUrl;
    order.deliveryProvider = provider;
    order.estimatedDelivery = shipment.estimatedDelivery;
    if (order.status === 'pending' || order.status === 'confirmed') {
      order.status = 'processing';
      order.timeline.push({ status: 'processing', description: 'Shipment created', timestamp: new Date() });
    }
    await order.save();

    const trackLink = `${clientUrl()}/track/${shipment.trackingNumber}`;
    if (order.customer?.email) {
      emailService.send({
        to: order.customer.email,
        subject: `Your order ${order.orderNumber} has shipped!`,
        html: emailService.baseTemplate('Order shipped', `
          <h2 style="color:#0f172a;margin:0 0 6px;">Your order is on its way! 📦</h2>
          <p style="color:#475569;font-size:14px;">Order <strong>${order.orderNumber}</strong> has shipped via <strong>${shipment.providerName}</strong>.</p>
          <p style="color:#475569;font-size:14px;">Tracking number: <strong>${shipment.trackingNumber}</strong></p>
          <p style="text-align:center;margin:20px 0;"><a href="${trackLink}" style="background:#6366f1;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Track Your Order</a></p>
        `, { name: company.companyName, logo: company.logo }),
      }).catch((e) => logger.warn(`Shipment email failed: ${e.message}`));
    }

    res.status(201).json({ success: true, data: shipment });
  } catch (err) { next(err); }
};

// ── GET /delivery/track/:trackingNumber (PUBLIC — no company scoping) ──────
exports.trackShipment = async (req, res, next) => {
  try {
    const shipment = await Shipment.findOne({ trackingNumber: req.params.trackingNumber });
    if (!shipment) return next(new AppError('No shipment found for this tracking number.', 404));

    // API-backed providers: refresh from the courier if our last poll is
    // stale, so a shopper checking the page sees a live status rather than
    // only whatever the last webhook happened to deliver.
    const STALE_MS = 30 * 60 * 1000;
    if (shipment.provider !== 'manual' && (!shipment.lastTrackedAt || Date.now() - shipment.lastTrackedAt.getTime() > STALE_MS)) {
      try {
        const company = await Company.findById(shipment.companyId).select('+deliverySettings.providers.gig.apiKey +deliverySettings.providers.kwik.apiKey +deliverySettings.providers.sendbox.apiKey');
        const live = await deliveryService.trackShipment(shipment.provider, company, shipment.trackingNumber);
        if (live) await applyTrackingUpdate(shipment, live);
      } catch (e) { logger.warn(`Live tracking refresh failed for ${shipment.trackingNumber}: ${e.message}`); }
    }

    const order = await Order.findById(shipment.orderId).select('orderNumber companyId');
    const company = order ? await Company.findById(order.companyId).select('companyName logo storeSlug storeEnabled') : null;

    res.status(200).json({
      success: true,
      data: {
        trackingNumber: shipment.trackingNumber,
        provider: shipment.providerName,
        status: shipment.status,
        orderNumber: order?.orderNumber || null,
        storeName: company?.companyName || null,
        storeLogo: company?.logo || null,
        storeSlug: company?.storeEnabled ? company.storeSlug : null,
        estimatedDelivery: shipment.estimatedDelivery,
        deliveredAt: shipment.deliveredAt,
        history: shipment.trackingHistory.slice().reverse(),
      },
    });
  } catch (err) { next(err); }
};

// ── PATCH /delivery/shipments/:id/status (protected — manual override) ─────
exports.updateShipmentStatus = async (req, res, next) => {
  try {
    const { status, location, description } = req.body;
    if (!Object.keys({ pending: 1, picked_up: 1, in_transit: 1, out_for_delivery: 1, delivered: 1, failed: 1, returned: 1 }).includes(status)) {
      return next(new AppError('Invalid status.', 400));
    }
    const shipment = await Shipment.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!shipment) return next(new AppError('Shipment not found.', 404));

    await applyTrackingUpdate(shipment, { status, location, history: null }, description);
    res.status(200).json({ success: true, data: shipment });
  } catch (err) { next(err); }
};

// Shared by the manual-update endpoint, the live-refresh poll in
// trackShipment, and every provider webhook — one place that pushes history,
// saves the shipment, and syncs the linked Order + notifies the customer.
async function applyTrackingUpdate(shipment, { status, location, estimatedDelivery, history }, description) {
  const statusChanged = status && status !== shipment.status;
  if (status) shipment.status = status;
  if (estimatedDelivery) shipment.estimatedDelivery = estimatedDelivery;
  if (history) shipment.trackingHistory = history.map((h) => ({ status: h.status, location: h.location, timestamp: h.timestamp ? new Date(h.timestamp) : new Date(), description: h.description }));
  else if (statusChanged) shipment.trackingHistory.push({ status, location, description: description || `Status updated to ${status}`, timestamp: new Date() });
  shipment.lastTrackedAt = new Date();
  if (status === 'delivered') shipment.deliveredAt = shipment.deliveredAt || new Date();
  await shipment.save();

  if (!statusChanged) return;

  const order = await Order.findById(shipment.orderId);
  if (!order) return;
  const company = await Company.findById(order.companyId).select('companyName logo smsSettings');

  const newOrderStatus = ORDER_STATUS_FOR_SHIPMENT[status];
  if (newOrderStatus && order.status !== newOrderStatus) {
    order.status = newOrderStatus;
    order.timeline.push({ status: newOrderStatus, description: `Shipment ${shipment.trackingNumber}: ${status}`, timestamp: new Date() });
    if (status === 'delivered') {
      order.deliveredAt = order.deliveredAt || new Date();
      awardLoyaltyForOrder(order, company).catch(() => {});
    }
    await order.save();
  }

  const copy = STATUS_COPY[status];
  if (copy && order.customer?.email) {
    emailService.send({
      to: order.customer.email, subject: copy.subject,
      html: emailService.baseTemplate(copy.subject, `<p style="color:#475569;font-size:14px;">${copy.text(order.orderNumber)}</p>`, { name: company?.companyName, logo: company?.logo }),
    }).catch(() => {});
  }
  if (copy && order.customer?.phone && company?.smsSettings?.enabled !== false && company?.smsSettings?.sendOrderSMS !== false) {
    sendSMS({ to: order.customer.phone, message: `${copy.text(order.orderNumber)} - BizlyAI` }).catch(() => {});
  }
}
exports.applyTrackingUpdate = applyTrackingUpdate;

// ── POST /delivery/providers/:provider/connect (manager+) ──────────────────
// Saves this company's OWN courier account credentials (see the model
// comment on deliverySettings.providers for why it's per-company).
exports.connectProvider = async (req, res, next) => {
  try {
    const { provider } = req.params;
    if (!PROVIDERS[provider]) return next(new AppError('Unknown delivery provider.', 400));
    const { apiKey, secretKey } = req.body;
    if (!apiKey?.trim()) return next(new AppError('An API key is required.', 400));

    const company = await Company.findById(req.companyId);
    if (!company.deliverySettings.providers) company.deliverySettings.providers = {};
    company.deliverySettings.providers[provider] = { apiKey: apiKey.trim(), secretKey: secretKey?.trim() || undefined, connected: true };
    await company.save();

    res.status(200).json({ success: true, message: `${PROVIDERS[provider].name} connected.` });
  } catch (err) { next(err); }
};

// ── DELETE /delivery/providers/:provider/connect (manager+) ────────────────
exports.disconnectProvider = async (req, res, next) => {
  try {
    const { provider } = req.params;
    if (!PROVIDERS[provider]) return next(new AppError('Unknown delivery provider.', 400));
    await Company.updateOne({ _id: req.companyId }, { $unset: { [`deliverySettings.providers.${provider}`]: 1 } });
    res.status(200).json({ success: true, message: `${PROVIDERS[provider].name} disconnected.` });
  } catch (err) { next(err); }
};

// ── POST /delivery/providers/:provider/test (manager+) ──────────────────────
// A cheap connectivity check — asks for a quote on a generic Lagos-to-Lagos
// 1kg parcel rather than requiring the caller to supply real addresses.
exports.testConnection = async (req, res, next) => {
  try {
    const { provider } = req.params;
    if (!PROVIDERS[provider]) return next(new AppError('Unknown delivery provider.', 400));
    const company = await Company.findById(req.companyId).select('+deliverySettings.providers.gig.apiKey +deliverySettings.providers.kwik.apiKey +deliverySettings.providers.sendbox.apiKey');
    if (!deliveryService.isConfigured(company, provider)) return next(new AppError('Connect this provider first.', 400));

    await deliveryService.getDeliveryQuote(provider, company, {
      senderAddress: { city: 'Lagos', state: 'Lagos', country: 'NG' },
      recipientAddress: { city: 'Lagos', state: 'Lagos', country: 'NG' },
      weight: 1,
    });
    res.status(200).json({ success: true, message: 'Connection successful.' });
  } catch (err) { next(err); }
};

// ── GET /delivery/shipments (protected) ─────────────────────────────────────
exports.getShipments = async (req, res, next) => {
  try {
    const { status, provider, orderId, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (provider) filter.provider = provider;
    if (orderId) filter.orderId = orderId;

    const [shipments, total] = await Promise.all([
      Shipment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Shipment.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: shipments, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

// ── Webhooks — public, best-effort field matching (see file header re: no
// verified signature scheme for GIG/Kwik; Sendbox's callback_url payload
// shape also isn't in their public docs). Accepts a handful of common field
// names per provider rather than one exact documented shape. ───────────────
async function handleWebhook(provider, req, res) {
  try {
    const body = req.body || {};
    const trackingNumber = body.tracking_code || body.trackingNumber || body.waybillNumber || body.code || body.tracking_number || body.reference;
    if (!trackingNumber) return res.status(400).json({ received: true, error: 'No tracking identifier in payload' });

    const shipment = await Shipment.findOne({ trackingNumber, provider });
    if (!shipment) return res.status(200).json({ received: true }); // unknown shipment — ack anyway, nothing to update

    const rawStatus = body.status_code || body.status?.code || body.status || body.current_status;
    const normalized = normalizeWebhookStatus(provider, rawStatus);
    if (normalized) {
      await applyTrackingUpdate(shipment, { status: normalized, location: body.location || body.location_description }, body.description);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error(`${provider} webhook failed: ${err.message}`);
    res.status(200).json({ received: true }); // never make a courier retry-storm us over our own bug
  }
}

function normalizeWebhookStatus(provider, raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (provider === 'sendbox') return { drafted: 'pending', pending: 'pending', pickup_started: 'picked_up', pickup_completed: 'picked_up', in_transit: 'in_transit', in_delivery: 'out_for_delivery', delivered: 'delivered' }[s] || null;
  if (['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'].includes(s)) return s;
  if (s.includes('deliver')) return 'delivered';
  if (s.includes('transit')) return 'in_transit';
  if (s.includes('pickup') || s.includes('picked')) return 'picked_up';
  if (s.includes('out for')) return 'out_for_delivery';
  return null;
}

exports.gigWebhook = (req, res) => handleWebhook('gig', req, res);
exports.kwikWebhook = (req, res) => handleWebhook('kwik', req, res);
exports.sendboxWebhook = (req, res) => handleWebhook('sendbox', req, res);
