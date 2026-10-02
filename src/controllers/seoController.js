'use strict';

const Company = require('../models/Company');
const Product = require('../models/Product');
const cache = require('../utils/cache');

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
