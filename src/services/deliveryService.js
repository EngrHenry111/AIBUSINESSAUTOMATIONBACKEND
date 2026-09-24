'use strict';

// Multi-provider Nigerian delivery integration. MANUAL is the fully-real,
// fully-tested default (see createManualShipment) — a business owner types
// in a tracking number/carrier by hand and updates status themselves, no API
// required. GIG/Kwik/Sendbox are real couriers with real APIs, but:
//   - Sendbox has genuinely public docs (docs.sendbox.co) — its adapter below
//     follows the real, documented request/response shapes.
//   - GIG Logistics and Kwik Delivery gate their actual API contracts behind
//     a partner login (an account "enabled for API integration by their
//     staff" per Kwik's own docs) — there is no way to verify their exact
//     endpoints/payloads without one. Their adapters below are a best-effort
//     scaffold based on how the rest of this style of courier API usually
//     works (bearer-token REST, JSON in/out) and are clearly NOT verified.
//     Do not rely on them working unmodified — get a real account, get their
//     actual current docs, and adjust buildGigRequest/buildKwikRequest
//     accordingly before turning a company's "connected" flag on for real.
const axios = require('axios');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');

const PROVIDERS = {
  gig: {
    name: 'GIG Logistics',
    baseUrl: process.env.GIG_BASE_URL || 'https://dev-thirdpartynode.theagilitysystems.com',
    verified: false,
  },
  kwik: {
    name: 'Kwik Delivery',
    baseUrl: process.env.KWIK_BASE_URL || 'https://api.kwik.delivery',
    verified: false,
  },
  sendbox: {
    name: 'Sendbox',
    baseUrl: process.env.SENDBOX_BASE_URL || 'https://live.sendbox.co/shipping',
    verified: true,
  },
};

// A company's own connected account always wins over the platform-wide env
// var fallback (see Company.deliverySettings.providers for why per-company).
function getCredentials(company, provider) {
  const stored = company?.deliverySettings?.providers?.[provider] || {};
  const envKeys = {
    gig: { apiKey: process.env.GIG_API_KEY },
    kwik: { apiKey: process.env.KWIK_API_KEY, secretKey: process.env.KWIK_SECRET_KEY },
    sendbox: { apiKey: process.env.SENDBOX_API_KEY },
  }[provider] || {};
  return {
    apiKey: stored.apiKey || envKeys.apiKey || null,
    secretKey: stored.secretKey || envKeys.secretKey || null,
  };
}

function isConfigured(company, provider) {
  if (provider === 'manual') return true;
  if (!PROVIDERS[provider]) return false;
  return Boolean(getCredentials(company, provider).apiKey);
}

async function providerRequest({ method, url, apiKey, data, extraHeaders }) {
  try {
    const res = await axios({
      method, url, data, timeout: 20000,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json', ...extraHeaders },
    });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    logger.error(`Delivery provider request failed [${method} ${url}]: ${msg}`);
    throw new AppError(`Delivery provider error: ${msg}`, err.response?.status && err.response.status < 500 ? 400 : 502);
  }
}

// ── Sendbox — verified against docs.sendbox.co ──────────────────────────────
const sendbox = {
  async quote(creds, { senderAddress, recipientAddress, weight }) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.sendbox.baseUrl}/shipment_delivery_quote`, apiKey: creds.apiKey,
      data: { origin: senderAddress, destination: recipientAddress, weight: weight || 1, currency: 'NGN', channel_code: 'api' },
    });
    const rate = data.rate || data.rates?.[0] || {};
    return { fee: rate.total || rate.amount || 0, estimatedDays: rate.delivery_days || null, currency: data.currency || 'NGN', raw: data };
  },
  async create(creds, s) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.sendbox.baseUrl}/shipments`, apiKey: creds.apiKey,
      data: {
        origin: { first_name: s.senderName, phone: s.senderAddress?.phone || s.senderPhone, street: s.senderAddress?.street, city: s.senderAddress?.city, state: s.senderAddress?.state, country: 'NG' },
        destination: { first_name: s.recipientName, phone: s.recipientPhone, street: s.recipientAddress?.street, city: s.recipientAddress?.city, state: s.recipientAddress?.state, country: 'NG' },
        weight: s.weight || 1, total_value: s.value || 0, currency: 'NGN', channel_code: 'api', service_type: 'nation-wide', incoming_option: 'pickup',
        items: (s.items || []).map((it) => ({ name: it.name, quantity: it.quantity || 1, value: it.price || 0, item_type: 'general' })),
      },
    });
    return {
      trackingNumber: data.tracking_code || data.code,
      trackingUrl: null,
      providerShipmentId: data._id || data.id,
      fee: data.fee || data.amount || 0,
      raw: data,
    };
  },
  async track(creds, trackingNumber) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.sendbox.baseUrl}/tracking`, apiKey: creds.apiKey, data: { code: trackingNumber },
    });
    return {
      status: mapSendboxStatus(data.status_code || data.status?.code),
      location: data.events?.[0]?.location_description || null,
      estimatedDelivery: data.delivery_eta || null,
      history: (data.events || []).map((e) => ({
        status: mapSendboxStatus(e.status_code || e.status?.code), location: e.location_description, timestamp: e.last_updated, description: e.description,
      })),
      raw: data,
    };
  },
  async cancel() {
    throw new AppError('Sendbox does not expose a documented cancel-shipment endpoint — cancel manually via their dashboard.', 400);
  },
};

function mapSendboxStatus(code) {
  return { drafted: 'pending', pending: 'pending', pickup_started: 'picked_up', pickup_completed: 'picked_up', in_transit: 'in_transit', in_delivery: 'out_for_delivery', delivered: 'delivered' }[code] || 'pending';
}

// ── GIG Logistics — UNVERIFIED scaffold (see file header) ───────────────────
const gig = {
  async quote(creds, { senderAddress, recipientAddress, weight }) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.gig.baseUrl}/price`, apiKey: creds.apiKey,
      data: { PreShipmentMobileUser: {}, sender: senderAddress, receiver: recipientAddress, weight: weight || 1 },
    });
    return { fee: data.price || data.total || 0, estimatedDays: data.estimatedDays || null, currency: 'NGN', raw: data };
  },
  async create(creds, s) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.gig.baseUrl}/shipment`, apiKey: creds.apiKey,
      data: {
        SenderName: s.senderName, SenderPhoneNumber: s.senderPhone, SenderAddress: s.senderAddress,
        ReceiverName: s.recipientName, ReceiverPhoneNumber: s.recipientPhone, ReceiverAddress: s.recipientAddress,
        Weight: s.weight || 1, Value: s.value || 0,
      },
    });
    return { trackingNumber: data.waybillNumber || data.trackingNumber, trackingUrl: data.trackingUrl || null, providerShipmentId: data.shipmentId || data.id, fee: data.price || 0, raw: data };
  },
  async track(creds, trackingNumber) {
    const data = await providerRequest({ method: 'GET', url: `${PROVIDERS.gig.baseUrl}/tracking/${encodeURIComponent(trackingNumber)}`, apiKey: creds.apiKey });
    return { status: 'in_transit', location: data.location || null, estimatedDelivery: data.estimatedDelivery || null, history: data.history || [], raw: data };
  },
  async cancel(creds, providerShipmentId) {
    return providerRequest({ method: 'POST', url: `${PROVIDERS.gig.baseUrl}/shipment/${encodeURIComponent(providerShipmentId)}/cancel`, apiKey: creds.apiKey });
  },
};

// ── Kwik Delivery — UNVERIFIED scaffold (see file header) ───────────────────
const kwik = {
  async quote(creds, { senderAddress, recipientAddress, weight }) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.kwik.baseUrl}/api/v1/quote`, apiKey: creds.apiKey,
      data: { pickup: senderAddress, dropoff: recipientAddress, weight: weight || 1 },
    });
    return { fee: data.price || data.fee || 0, estimatedDays: data.eta_days || null, currency: 'NGN', raw: data };
  },
  async create(creds, s) {
    const data = await providerRequest({
      method: 'POST', url: `${PROVIDERS.kwik.baseUrl}/api/v1/orders`, apiKey: creds.apiKey,
      data: {
        pickup: { name: s.senderName, phone: s.senderPhone, address: s.senderAddress },
        dropoff: { name: s.recipientName, phone: s.recipientPhone, address: s.recipientAddress },
        weight: s.weight || 1, value: s.value || 0,
      },
    });
    return { trackingNumber: data.tracking_number || data.reference, trackingUrl: data.tracking_url || null, providerShipmentId: data.order_id || data.id, fee: data.price || 0, raw: data };
  },
  async track(creds, trackingNumber) {
    const data = await providerRequest({ method: 'GET', url: `${PROVIDERS.kwik.baseUrl}/api/v1/orders/${encodeURIComponent(trackingNumber)}`, apiKey: creds.apiKey });
    return { status: data.status || 'in_transit', location: data.current_location || null, estimatedDelivery: data.eta || null, history: data.history || [], raw: data };
  },
  async cancel(creds, providerShipmentId) {
    return providerRequest({ method: 'POST', url: `${PROVIDERS.kwik.baseUrl}/api/v1/orders/${encodeURIComponent(providerShipmentId)}/cancel`, apiKey: creds.apiKey });
  },
};

const ADAPTERS = { gig, kwik, sendbox };

async function getDeliveryQuote(provider, company, params) {
  if (provider === 'manual' || !ADAPTERS[provider]) return { fee: null, estimatedDays: company?.deliverySettings?.estimatedDeliveryDays || 3, currency: 'NGN', manual: true };
  const creds = getCredentials(company, provider);
  if (!creds.apiKey) throw new AppError(`${PROVIDERS[provider]?.name || provider} is not connected for this store.`, 400);
  return ADAPTERS[provider].quote(creds, params);
}

async function createShipment(provider, company, params) {
  if (provider === 'manual' || !ADAPTERS[provider]) return createManualShipment(params);
  const creds = getCredentials(company, provider);
  if (!creds.apiKey) throw new AppError(`${PROVIDERS[provider]?.name || provider} is not connected for this store.`, 400);
  return ADAPTERS[provider].create(creds, params);
}

async function trackShipment(provider, company, trackingNumber) {
  if (provider === 'manual' || !ADAPTERS[provider]) return null; // manual shipments carry their own status, nothing to poll
  const creds = getCredentials(company, provider);
  if (!creds.apiKey) throw new AppError(`${PROVIDERS[provider]?.name || provider} is not connected for this store.`, 400);
  return ADAPTERS[provider].track(creds, trackingNumber);
}

async function cancelShipment(provider, company, providerShipmentId) {
  if (provider === 'manual' || !ADAPTERS[provider]) return { cancelled: true, manual: true };
  const creds = getCredentials(company, provider);
  if (!creds.apiKey) throw new AppError(`${PROVIDERS[provider]?.name || provider} is not connected for this store.`, 400);
  return ADAPTERS[provider].cancel(creds, providerShipmentId);
}

// No API call — just the shape a manually-tracked shipment needs. Exists
// mainly so callers have one consistent entry point regardless of provider.
async function createManualShipment({ trackingNumber, estimatedDays }) {
  return {
    trackingNumber, trackingUrl: null, providerShipmentId: null, fee: null,
    estimatedDelivery: estimatedDays ? new Date(Date.now() + estimatedDays * 24 * 60 * 60 * 1000) : null,
  };
}

module.exports = {
  PROVIDERS, getCredentials, isConfigured,
  getDeliveryQuote, createShipment, trackShipment, cancelShipment, createManualShipment,
};
