'use strict';

/**
 * What the inbox AI knows besides the knowledge base:
 *
 *  catalogContext()  the business's live products — price, sale price,
 *                    stock, options and a link to buy — picked for the
 *                    customer's question. Never cost price or exact stock.
 *  customerContext() who this customer is to the business: their recent
 *                    orders (status, payment, tracking link) and what they
 *                    asked before on other channels. Only for channels where
 *                    the platform vouches for identity (WhatsApp number) —
 *                    a website visitor can type anyone's phone number.
 *
 * Both return plain text for the prompt ('' when there's nothing to say)
 * and never throw.
 */
const Company = require('../../models/Company');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Conversation = require('../../models/Conversation');
const Contact = require('../../models/Contact');
const logger = require('../../utils/logger');
const { phoneVariants } = require('./contacts');

const VERIFIED_CHANNELS = new Set(['whatsapp', 'facebook', 'instagram', 'telegram']);
const SMALL_CATALOG = 40; // list everything up to this many products
const PICK = 15; // otherwise, this many best matches
const CACHE_MS = 60 * 1000;

const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

// ── Formatting ─────────────────────────────────────────────────────────────
const SYMBOL = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: 'GH₵', KES: 'KSh ', ZAR: 'R' };
function money(n, currency = 'NGN') {
  if (typeof n !== 'number' || Number.isNaN(n)) return '';
  const code = String(currency || 'NGN').toUpperCase();
  const amount = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return SYMBOL[code] ? `${SYMBOL[code]}${amount}` : `${code} ${amount}`;
}
const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function stockText(p) {
  const s = p.stock || {};
  if (p.status === 'out_of_stock') return 'Out of stock';
  if (s.trackStock === false) return 'Available';
  const q = Number(s.quantity) || 0;
  if (q <= 0) return s.allowOutOfStock ? 'Available to pre-order' : 'Out of stock';
  if (q <= (Number(s.lowStockThreshold) || 5)) return `Only ${q} left`;
  return 'In stock';
}

function priceText(p) {
  const base = money(p.price, p.currency);
  const onSale = p.isFlashSale && typeof p.flashSalePrice === 'number'
    && (!p.flashSaleEndsAt || new Date(p.flashSaleEndsAt) > new Date());
  if (!onSale) return base;
  return `${money(p.flashSalePrice, p.currency)} on sale (normally ${base}${p.flashSaleEndsAt ? `, sale ends ${day(p.flashSaleEndsAt)}` : ''})`;
}

function productLine(p, storeUrl) {
  const parts = [p.name, priceText(p), stockText(p)];
  if (p.category) parts.push(`Category: ${p.category}`);
  const opts = (p.variants || [])
    .filter((v) => v?.name && v.options?.length)
    .map((v) => `${v.name}: ${v.options.map((o) => (typeof o.price === 'number' && o.price !== p.price ? `${o.value} (${money(o.price, p.currency)})` : o.value)).join(', ')}`);
  if (opts.length) parts.push(`Options: ${opts.join('; ')}`);
  if (p.description) parts.push(`About: ${String(p.description).replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  if (storeUrl) parts.push(`Link: ${storeUrl}/product/${p._id}`);
  return `- ${parts.join(' | ')}`;
}

// ── Matching products to the question ─────────────────────────────────────
const STOP = new Set(('the and for you your have has with what which how much many any are is was this that from please can '
  + 'want need buy price cost sell selling store shop products product item items there they them get got'
  + ' do does did will would could should about available hello hi hey good morning evening').split(' '));
const words = (t) => String(t || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const terms = (t) => [...new Set(words(t).filter((w) => w.length >= 3 && !STOP.has(w)))];

function score(p, qTerms) {
  if (!qTerms.length) return 0;
  const name = words(p.name);
  const tags = [...words(p.category), ...(p.tags || []).flatMap(words)];
  const desc = words(p.description);
  // "shoes" should match "shoe" and vice versa.
  const has = (list, t) => list.some((w) => w === t || (t.length > 3 && (w.startsWith(t) || t.startsWith(w)) && Math.abs(w.length - t.length) <= 2));
  return qTerms.reduce((n, t) => n + (has(name, t) ? 3 : 0) + (has(tags, t) ? 2 : 0) + (has(desc, t) ? 1 : 0), 0);
}

// ── Catalog (cached per company for a minute) ─────────────────────────────
const cache = new Map();
async function loadCatalog(companyId) {
  const key = String(companyId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const company = await Company.findById(companyId).select('companyName storeSlug storeEnabled storeSettings.showOutOfStock').lean();
  let products = await Product.find({ companyId, status: { $in: ['active', 'out_of_stock'] } })
    .select('name description category tags price currency stock status variants isFlashSale flashSalePrice flashSaleEndsAt isFeatured sold')
    .sort({ isFeatured: -1, sold: -1, createdAt: -1 })
    .limit(1000)
    .lean();
  if (company?.storeSettings?.showOutOfStock === false) products = products.filter((p) => stockText(p) !== 'Out of stock');

  const value = {
    businessName: company?.companyName || '',
    storeUrl: company?.storeEnabled && company.storeSlug ? `${clientUrl()}/store/${company.storeSlug}` : null,
    products,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * @returns {Promise<{text: string, businessName: string, storeUrl: string|null, count: number}>}
 */
async function catalogContext(companyId, question) {
  try {
    const { businessName, storeUrl, products } = await loadCatalog(companyId);
    if (!products.length) return { text: '', businessName, storeUrl, count: 0 };

    let picked;
    let note = '';
    if (products.length <= SMALL_CATALOG) {
      picked = products;
    } else {
      const q = terms(question);
      const ranked = products.map((p, i) => ({ p, s: score(p, q), i })).sort((a, b) => b.s - a.s || a.i - b.i);
      const matches = ranked.filter((r) => r.s > 0).slice(0, PICK).map((r) => r.p);
      // Few or no matches (e.g. "what do you sell?"): fill with featured / best sellers.
      picked = matches.length >= 5 ? matches : [...matches, ...products.filter((p) => !matches.includes(p)).slice(0, PICK - matches.length)];
      const cats = [...new Set(products.map((p) => p.category).filter(Boolean))];
      note = `\n(Showing ${picked.length} of ${products.length} products${matches.length ? ' that best match the question' : ', featured and best sellers first'}.`
        + `${cats.length ? ` All categories: ${cats.slice(0, 30).join(', ')}.` : ''} If the customer wants something not listed here, ask what they're looking for or send the store link.)`;
    }

    const head = storeUrl ? `Online store (customers can order and pay here): ${storeUrl}` : 'The business has no online store link; customers order by chatting.';
    const text = `${head}\n${picked.map((p) => productLine(p, storeUrl)).join('\n')}${note}`;
    return { text, businessName, storeUrl, count: products.length };
  } catch (err) {
    logger.warn(`Inbox catalog context failed (company ${companyId}): ${err.message}`);
    return { text: '', businessName: '', storeUrl: null, count: 0 };
  }
}

// ── The customer ───────────────────────────────────────────────────────────
const ORDER_STATUS = {
  pending: 'received, awaiting confirmation', confirmed: 'confirmed', processing: 'being prepared',
  shipped: 'on its way', delivered: 'delivered', cancelled: 'cancelled', refunded: 'refunded',
};

async function customerContext(convo, { storeUrl } = {}) {
  try {
    if (!VERIFIED_CHANNELS.has(convo.channel)) return '';
    const lines = [];
    const contact = convo.contactId
      ? await Contact.findById(convo.contactId).select('name email phone phoneKey firstSeenAt').lean()
      : null;

    const name = contact?.name || (convo.displayName !== convo.phone ? convo.displayName : null);
    if (name) lines.push(`Name: ${name}`);
    if (contact?.firstSeenAt) lines.push(`First contacted the business: ${day(contact.firstSeenAt)}`);

    // Orders placed with this phone number (or the contact's email). On
    // Telegram a typed number proves nothing — only one shared with the
    // "Share my phone number" button does.
    if (convo.channel === 'telegram' && !convo.meta?.phoneVerified) return lines.join('\n');
    const phone = convo.phone || contact?.phone;
    const key = Contact.phoneKeyOf(phone);
    const or = [];
    const variants = phoneVariants(phone, key);
    if (variants.length) or.push({ 'customer.phone': { $in: variants } });
    if (contact?.email) or.push({ 'customer.email': contact.email });
    if (or.length) {
      const orders = await Order.find({ companyId: convo.companyId, $or: or })
        .select('orderNumber createdAt items total currency status paymentStatus trackingUrl')
        .sort({ createdAt: -1 }).limit(3).lean();
      if (orders.length) {
        lines.push('Recent orders (newest first):');
        for (const o of orders) {
          const items = (o.items || []).slice(0, 4).map((i) => `${i.quantity || 1}x ${i.name}`).join(', ');
          const track = o.trackingUrl || (storeUrl ? `${storeUrl}/track/${o.orderNumber}` : '');
          lines.push(`- Order ${o.orderNumber} on ${day(o.createdAt)}: ${items || 'items'} | total ${money(o.total, o.currency)} | ${ORDER_STATUS[o.status] || o.status} | payment ${o.paymentStatus || 'unknown'}${track ? ` | track: ${track}` : ''}`);
        }
      }
    }

    // What they asked before, in other chats with this business.
    if (convo.contactId) {
      const others = await Conversation.find({ companyId: convo.companyId, contactId: convo.contactId, _id: { $ne: convo._id } })
        .select('channel lastMessageAt messages').sort({ lastMessageAt: -1 }).limit(2).lean();
      for (const c of others) {
        const asked = (c.messages || []).filter((m) => m.from === 'customer').slice(-3).map((m) => `"${String(m.content).slice(0, 120)}"`);
        if (asked.length) lines.push(`Earlier ${c.channel === 'widget' ? 'website' : c.channel} chat (${day(c.lastMessageAt)}): ${asked.join(', ')}`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    logger.warn(`Inbox customer context failed: ${err.message}`);
    return '';
  }
}

const forget = (companyId) => cache.delete(String(companyId));

module.exports = { catalogContext, customerContext, forget, _test: { money, stockText, priceText, score, terms } };
