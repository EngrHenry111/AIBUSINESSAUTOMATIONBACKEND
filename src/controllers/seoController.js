'use strict';

const mongoose = require('mongoose');
const Company = require('../models/Company');
const Product = require('../models/Product');
const cache = require('../utils/cache');
const { findStore } = require('./storefrontController');

// Public site origin — the sitemap must list frontend URLs, never API ones.
const SITE_URL = (process.env.CLIENT_URL?.split(',')[0] || 'https://bislyai.com').trim().replace(/\/+$/, '');

const STATIC_PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/market', changefreq: 'daily', priority: '0.9' },
  { path: '/register', changefreq: 'monthly', priority: '0.8' },
  { path: '/login', changefreq: 'monthly', priority: '0.5' },
  { path: '/security', changefreq: 'monthly', priority: '0.4' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
];

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function urlEntry({ loc, lastmod, changefreq, priority }) {
  return [
    '  <url>',
    `    <loc>${xmlEscape(loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
    priority ? `    <priority>${priority}</priority>` : null,
    '  </url>',
  ].filter(Boolean).join('\n');
}

// ── GET /seo/sitemap.xml ─────────────────────────────────────────────────
// Built from the live DB so a store appears here the moment it's enabled
// (sign-up enables it by default) — no redeploy needed. Same visibility
// rules as the marketplace: storeEnabled and not admin-suspended. Cached
// briefly; Google re-fetches sitemaps on its own schedule anyway.
exports.getSitemap = async (req, res, next) => {
  try {
    let xml = cache.get('seo_sitemap');
    if (!xml) {
      const stores = await Company.find({ storeEnabled: true, storeSlug: { $nin: [null, ''] }, 'marketplace.isSuspended': { $ne: true } })
        .select('_id storeSlug updatedAt').lean();
      const slugById = new Map(stores.map((c) => [String(c._id), c.storeSlug]));

      // Sitemap protocol caps a single file at 50,000 URLs.
      const products = await Product.find({ companyId: { $in: stores.map((c) => c._id) }, status: { $ne: 'inactive' } })
        .select('_id companyId updatedAt').sort({ updatedAt: -1 }).limit(45000).lean();

      const latestByStore = new Map();
      for (const p of products) {
        const k = String(p.companyId);
        if (!latestByStore.has(k)) latestByStore.set(k, p.updatedAt); // sorted desc → first is newest
      }

      const today = isoDate(Date.now());
      const entries = [
        ...STATIC_PAGES.map((p) => urlEntry({ loc: `${SITE_URL}${p.path}`, lastmod: p.path === '/market' ? today : null, changefreq: p.changefreq, priority: p.priority })),
        ...stores.map((c) => {
          const newest = [c.updatedAt, latestByStore.get(String(c._id))].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];
          return urlEntry({ loc: `${SITE_URL}/store/${c.storeSlug}`, lastmod: isoDate(newest), changefreq: 'daily', priority: '0.8' });
        }),
        ...products.map((p) => urlEntry({
          loc: `${SITE_URL}/store/${slugById.get(String(p.companyId))}/product/${p._id}`,
          lastmod: isoDate(p.updatedAt), changefreq: 'weekly', priority: '0.6',
        })),
      ];

      xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
      cache.set('seo_sitemap', xml);
    }

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=900');
    res.status(200).send(xml);
  } catch (err) { next(err); }
};

// ── Per-store installable app + crawler-facing <head> ────────────────────
const PLATFORM_ICONS = [
  { src: `${SITE_URL}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: `${SITE_URL}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: `${SITE_URL}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

// Chrome only offers "Install" when the manifest has real 192px and 512px
// icons. Store logos are arbitrary-sized Cloudinary uploads, so ask
// Cloudinary for padded square PNGs at exactly those sizes; a logo hosted
// anywhere else falls back to the platform icon rather than declaring a
// size it may not have.
function cloudinarySquare(url, size) {
  if (!url || !/res\.cloudinary\.com\/.+\/upload\//.test(url)) return null;
  return url.replace('/upload/', `/upload/c_pad,b_white,w_${size},h_${size},f_png/`);
}

function storeIcons(logo) {
  if (!cloudinarySquare(logo, 192)) return PLATFORM_ICONS;
  return [192, 512].map((n) => ({ src: cloudinarySquare(logo, n), sizes: `${n}x${n}`, type: 'image/png', purpose: 'any' }));
}

const storeDescription = (c) => c.storeSettings?.description || c.profile?.tagline
  || `Shop ${c.companyName} online on BizlyAI — browse products, order and pay securely with delivery across Nigeria.`;
const themeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c.storeSettings?.primaryColor || '') ? c.storeSettings.primaryColor : '#6366f1');
const shortName = (name) => (name.length <= 12 ? name : name.split(/\s+/)[0].slice(0, 12));
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 160);

// ── GET /seo/store/:slug/manifest.webmanifest ────────────────────────────
// Every store installs as ITS OWN app (its name, icon, colour and start
// page), not as BizlyAI. Scope has no trailing slash so both /store/x and
// /store/x/... count as inside the app.
exports.getStoreManifest = async (req, res, next) => {
  try {
    const c = await findStore(req.params.slug);
    const base = `/store/${c.storeSlug}`;
    res.set('Content-Type', 'application/manifest+json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).send(JSON.stringify({
      id: base,
      name: c.companyName,
      short_name: shortName(c.companyName),
      description: storeDescription(c).slice(0, 300),
      start_url: `${base}?source=pwa`,
      scope: base,
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#ffffff',
      theme_color: themeColor(c),
      categories: ['shopping'],
      icons: storeIcons(c.logo),
    }));
  } catch (err) { next(err); }
};

// ── GET /seo/page-meta?path=/store/:slug[/product/:id] ───────────────────
// Consumed by the frontend's edge middleware (frontend/middleware.js), which
// writes these into the HTML it serves for that URL. Link-preview bots
// (WhatsApp, Facebook, X) never run JS, so without this every shared store
// link previewed as generic BizlyAI.
exports.getPageMeta = async (req, res, next) => {
  try {
    const m = String(req.query.path || '').match(/^\/store\/([a-z0-9-]+)(?:\/product\/([^/?#]+))?\/?$/i);
    if (!m || (m[2] && !mongoose.isValidObjectId(m[2]))) return res.status(404).json({ success: false });

    const cacheKey = `seo_meta:${m[1].toLowerCase()}:${m[2] || ''}`;
    let meta = cache.get(cacheKey);
    if (!meta) {
      const c = await findStore(m[1]);
      const storeUrl = `${SITE_URL}/store/${c.storeSlug}`;
      const shared = {
        appName: shortName(c.companyName),
        siteName: c.companyName,
        themeColor: themeColor(c),
        manifest: `/api/v1/seo/store/${c.storeSlug}/manifest.webmanifest`,
        appleIcon: cloudinarySquare(c.logo, 180) || '/apple-touch-icon.png',
      };

      if (m[2]) {
        const p = await Product.findOne({ _id: m[2], companyId: c._id, status: { $ne: 'inactive' } })
          .select('name description images price currency sku category stock ratings').lean();
        if (!p) return res.status(404).json({ success: false });
        const url = `${storeUrl}/product/${p._id}`;
        const description = oneLine(p.description || `Buy ${p.name} from ${c.companyName}. Secure payment and delivery across Nigeria.`);
        meta = {
          ...shared,
          title: `${p.name} — ${c.companyName}`,
          description,
          canonical: url,
          image: p.images?.[0] || c.storeSettings?.banner || c.logo || null,
          ogType: 'product',
          jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: p.name,
            description,
            ...(p.images?.length && { image: p.images }),
            ...(p.sku && { sku: p.sku }),
            ...(p.category && { category: p.category }),
            brand: { '@type': 'Brand', name: c.companyName },
            offers: {
              '@type': 'Offer',
              url,
              priceCurrency: p.currency || 'NGN',
              price: p.price,
              availability: !p.stock?.trackStock || p.stock.quantity > 0 || p.stock.allowOutOfStock
                ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
              seller: { '@type': 'Organization', name: c.companyName },
            },
            ...(p.ratings?.count > 0 && {
              aggregateRating: { '@type': 'AggregateRating', ratingValue: p.ratings.average, reviewCount: p.ratings.count },
            }),
          },
        };
      } else {
        const description = oneLine(storeDescription(c));
        meta = {
          ...shared,
          title: `${c.companyName} — Online Store`,
          description,
          canonical: storeUrl,
          image: c.storeSettings?.banner || c.logo || null,
          ogType: 'website',
          jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'Store',
            '@id': storeUrl,
            name: c.companyName,
            url: storeUrl,
            description,
            ...(c.logo && { logo: c.logo, image: c.logo }),
            ...(c.profile?.phone && { telephone: c.profile.phone }),
            ...(c.profile?.email && { email: c.profile.email }),
            ...(c.profile?.address && { address: { '@type': 'PostalAddress', streetAddress: c.profile.address, addressCountry: 'NG' } }),
            currenciesAccepted: 'NGN',
          },
        };
      }
      cache.set(cacheKey, meta, 300);
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ success: true, data: meta });
  } catch (err) {
    // Unknown/disabled/suspended store: let the SPA render its own error page.
    if (err.statusCode === 404 || err.statusCode === 403) return res.status(404).json({ success: false });
    next(err);
  }
};
