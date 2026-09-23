'use strict';

const Company = require('../models/Company');
const Product = require('../models/Product');
const Order = require('../models/Order');
const cache = require('../utils/cache');

const CATEGORIES = ['Fashion', 'Food', 'Electronics', 'Beauty', 'Home', 'Services', 'Agriculture', 'Other'];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A store card never includes the company's internal _id — storeSlug is the
// only identifier the marketplace (or anything downstream of it) needs,
// same convention as storefrontController's publicStore()/publicProduct().
function publicStoreCard(company, stats) {
  const rating = stats?.ratedCount ? Math.round((stats.ratedSum / stats.ratedCount) * 10) / 10 : 0;
  return {
    storeName: company.companyName,
    storeSlug: company.storeSlug,
    description: company.storeSettings?.description || null,
    banner: company.storeSettings?.banner || null,
    logo: company.logo || null,
    category: company.marketplace?.category || 'Other',
    location: company.marketplace?.location || null,
    isVerified: Boolean(company.marketplace?.isVerified),
    isFeatured: Boolean(company.marketplace?.isFeatured),
    rating,
    reviewCount: stats?.ratedCount || 0,
    productCount: stats?.productCount || 0,
    listedSince: company.createdAt,
  };
}

// Product-level ratings rolled up to the store. Unrated products (no
// reviews yet) are excluded from the average rather than dragging it down
// toward 0 — "productCount" separately reports the full catalog size.
async function ratingAndCountByCompany(companyIds) {
  if (!companyIds.length) return new Map();
  const agg = await Product.aggregate([
    { $match: { companyId: { $in: companyIds }, status: { $ne: 'inactive' } } },
    { $group: {
      _id: '$companyId',
      productCount: { $sum: 1 },
      ratedSum: { $sum: { $cond: [{ $gt: ['$ratings.count', 0] }, '$ratings.average', 0] } },
      ratedCount: { $sum: { $cond: [{ $gt: ['$ratings.count', 0] }, 1, 0] } },
    } },
  ]);
  return new Map(agg.map((a) => [String(a._id), a]));
}

const STORE_FIELDS = 'companyName storeSlug logo storeSettings marketplace createdAt';

// ── GET /marketplace ──────────────────────────────────────────────────────
exports.getMarketplace = async (req, res, next) => {
  try {
    const { category, location, search, verified, sort = 'featured', page = 1, limit = 20 } = req.query;
    const cacheKey = `marketplace_stores_${category || ''}_${location || ''}_${search || ''}_${verified || ''}_${sort}_${page}_${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.status(200).json(cached);

    const q = { storeEnabled: true, 'marketplace.isSuspended': { $ne: true } };
    if (category) q['marketplace.category'] = category;
    if (location) q['marketplace.location'] = { $regex: escapeRegex(location), $options: 'i' };
    if (verified === 'true') q['marketplace.isVerified'] = true;
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      q.$or = [{ companyName: rx }, { 'storeSettings.description': rx }, { 'marketplace.tags': rx }];
    }

    // Fetched in full (no DB-level pagination) since sorting by rating needs
    // the Product-side aggregation first — fine at this platform's realistic
    // store count; revisit if the marketplace ever reaches thousands of stores.
    const companies = await Company.find(q).select(STORE_FIELDS).lean();
    const statsMap = await ratingAndCountByCompany(companies.map((c) => c._id));
    const cards = companies.map((c) => publicStoreCard(c, statsMap.get(String(c._id))));

    if (sort === 'rating') cards.sort((a, b) => b.rating - a.rating);
    else if (sort === 'newest') cards.sort((a, b) => new Date(b.listedSince) - new Date(a.listedSince));
    else cards.sort((a, b) => (b.isFeatured - a.isFeatured) || b.rating - a.rating); // 'featured' (default)

    const total = cards.length;
    const start = (Number(page) - 1) * Number(limit);
    const paged = cards.slice(start, start + Number(limit));

    const payload = { success: true, data: paged, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) || 1 } };
    cache.set(cacheKey, payload);
    res.status(200).json(payload);
  } catch (err) { next(err); }
};

// ── GET /marketplace/featured ──────────────────────────────────────────────
exports.getFeaturedStores = async (req, res, next) => {
  try {
    const cached = cache.get('marketplace_featured');
    if (cached) return res.status(200).json(cached);

    let companies = await Company.find({ storeEnabled: true, 'marketplace.isSuspended': { $ne: true }, 'marketplace.isFeatured': true }).select(STORE_FIELDS).limit(6).lean();

    if (companies.length < 6) {
      const excludeIds = companies.map((c) => c._id);
      const fillers = await Company.find({ storeEnabled: true, 'marketplace.isSuspended': { $ne: true }, _id: { $nin: excludeIds } }).select(STORE_FIELDS).lean();
      const fillerStats = await ratingAndCountByCompany(fillers.map((c) => c._id));
      const ranked = fillers
        .map((c) => ({ c, rating: fillerStats.get(String(c._id))?.ratedCount ? fillerStats.get(String(c._id)).ratedSum / fillerStats.get(String(c._id)).ratedCount : 0 }))
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 6 - companies.length)
        .map((x) => x.c);
      companies = [...companies, ...ranked];
    }

    const statsMap = await ratingAndCountByCompany(companies.map((c) => c._id));
    const payload = { success: true, data: companies.map((c) => publicStoreCard(c, statsMap.get(String(c._id)))) };
    cache.set('marketplace_featured', payload);
    res.status(200).json(payload);
  } catch (err) { next(err); }
};

// ── GET /marketplace/search?q= ───────────────────────────────────────────
// Searches products across every enabled store — each result carries its
// store's name/slug so the UI can link straight to that store's product page.
exports.searchMarketplace = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(200).json({ success: true, data: [] });

    const stores = await Company.find({ storeEnabled: true, 'marketplace.isSuspended': { $ne: true } }).select('_id companyName storeSlug').lean();
    if (!stores.length) return res.status(200).json({ success: true, data: [] });
    const storeMap = new Map(stores.map((c) => [String(c._id), c]));

    const rx = { $regex: escapeRegex(q), $options: 'i' };
    const products = await Product.find({
      companyId: { $in: stores.map((c) => c._id) },
      status: { $ne: 'inactive' },
      $or: [{ name: rx }, { description: rx }, { category: rx }, { tags: rx }],
    }).limit(60).lean();

    const { publicProduct } = require('./storefrontController');
    const data = products.map((p) => {
      const store = storeMap.get(String(p.companyId));
      return { ...publicProduct(p), store: { name: store?.companyName || null, slug: store?.storeSlug || null } };
    });

    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

// ── GET /marketplace/categories ───────────────────────────────────────────
exports.getMarketplaceCategories = async (req, res, next) => {
  try {
    const cached = cache.get('marketplace_categories');
    if (cached) return res.status(200).json(cached);

    const counts = await Company.aggregate([
      { $match: { storeEnabled: true, 'marketplace.isSuspended': { $ne: true } } },
      { $group: { _id: { $ifNull: ['$marketplace.category', 'Other'] }, count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));
    const payload = { success: true, data: CATEGORIES.map((cat) => ({ category: cat, storeCount: countMap.get(cat) || 0 })) };
    cache.set('marketplace_categories', payload);
    res.status(200).json(payload);
  } catch (err) { next(err); }
};

// ── GET /marketplace/stats ────────────────────────────────────────────────
// Social-proof numbers for the landing/marketplace hero — cached like the
// rest of this controller since it's public and doesn't need to be exact
// to the second.
exports.getMarketplaceStats = async (req, res, next) => {
  try {
    const cached = cache.get('marketplace_stats');
    if (cached) return res.status(200).json(cached);

    const enabledStores = await Company.find({ storeEnabled: true, 'marketplace.isSuspended': { $ne: true } }).select('_id').lean();
    const storeIds = enabledStores.map((c) => c._id);
    const [totalProducts, totalOrders] = await Promise.all([
      Product.countDocuments({ companyId: { $in: storeIds }, status: { $ne: 'inactive' } }),
      Order.countDocuments({ companyId: { $in: storeIds }, source: 'storefront' }),
    ]);

    const payload = { success: true, data: { totalStores: storeIds.length, totalProducts, totalOrders } };
    cache.set('marketplace_stats', payload);
    res.status(200).json(payload);
  } catch (err) { next(err); }
};

// ── GET /marketplace/trending ──────────────────────────────────────────────
// Top-selling products across every enabled store, each carrying its store's
// name/slug — same shape as searchMarketplace's results.
exports.getTrendingProducts = async (req, res, next) => {
  try {
    const cached = cache.get('marketplace_trending');
    if (cached) return res.status(200).json(cached);

    const stores = await Company.find({ storeEnabled: true, 'marketplace.isSuspended': { $ne: true } }).select('_id companyName storeSlug').lean();
    if (!stores.length) return res.status(200).json({ success: true, data: [] });
    const storeMap = new Map(stores.map((c) => [String(c._id), c]));

    const products = await Product.find({
      companyId: { $in: stores.map((c) => c._id) }, status: { $ne: 'inactive' },
    }).sort({ sold: -1, viewCount: -1 }).limit(12).lean();

    const { publicProduct } = require('./storefrontController');
    const payload = {
      success: true,
      data: products.map((p) => {
        const store = storeMap.get(String(p.companyId));
        return { ...publicProduct(p), store: { name: store?.companyName || null, slug: store?.storeSlug || null } };
      }),
    };
    cache.set('marketplace_trending', payload);
    res.status(200).json(payload);
  } catch (err) { next(err); }
};
