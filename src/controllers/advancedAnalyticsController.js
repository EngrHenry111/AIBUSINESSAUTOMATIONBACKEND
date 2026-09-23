'use strict';

const Company = require('../models/Company');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Expense = require('../models/Expense');
const Appointment = require('../models/Appointment');
const { runAgent } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');
const cache = require('../utils/cache');

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
const NON_REVENUE_ORDER_STATUS = ['cancelled', 'refunded'];

// ── Shared period resolution — every endpoint accepts period=7d|30d|90d|1y
// or an explicit startDate/endDate, and gets an equal-length "previous
// period" window for free for growth% comparisons. ────────────────────────
function resolvePeriod(req) {
  const { period = '30d', startDate, endDate } = req.query;
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - (PERIOD_DAYS[period] || 30) * DAY_MS);
  const spanMs = Math.max(DAY_MS, end.getTime() - start.getTime());
  return {
    start, end,
    prevStart: new Date(start.getTime() - spanMs),
    prevEnd: new Date(start.getTime()),
    days: Math.max(1, Math.round(spanMs / DAY_MS)),
    periodKey: `${period}_${startDate || ''}_${endDate || ''}`,
  };
}

const pctChange = (curr, prev) => {
  if (!prev) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
};
const round2 = (n) => Math.round((n || 0) * 100) / 100;
const dateKey = (d) => new Date(d).toISOString().slice(0, 10);

function cacheKey(type, companyId, extra = '') {
  return `analytics_${type}_${companyId}_${extra}`;
}

async function withCache(key, ttlSeconds, fn) {
  const cached = cache.get(key);
  if (cached) return { data: cached, cached: true };
  const data = await fn();
  cache.set(key, data, ttlSeconds);
  return { data, cached: false };
}

// Zero-filled list of calendar days from start to end (inclusive), capped at
// 366 entries — the widest period this endpoint supports is 1y.
function dailyBuckets(start, end) {
  const days = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);
  while (cursor <= last && days.length < 366) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// Revenue recognized = paid invoices (by paidAt) + all non-cancelled orders
// (by createdAt, both source types) — the same "what actually came in"
// definition used across this app (see adminController's marketplace GMV).
async function computeRevenueForRange(companyId, start, end) {
  const [invoiceAgg, orderAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: { companyId, status: 'paid', paidAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$ngnEquivalent', '$total'] } } } },
    ]),
    Order.aggregate([
      { $match: { companyId, createdAt: { $gte: start, $lte: end }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
      { $group: { _id: '$source', total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
  ]);
  const invoices = invoiceAgg[0]?.total || 0;
  const storeOrders = orderAgg.find((o) => o._id === 'storefront')?.total || 0;
  const manual = orderAgg.find((o) => o._id !== 'storefront')?.total || 0;
  const orderCount = orderAgg.reduce((s, o) => s + o.count, 0);
  return { total: invoices + storeOrders + manual, invoices, storeOrders, manual, orderCount };
}

async function orderItemsRevenueByProduct(companyId, start, end) {
  const rows = await Order.aggregate([
    { $match: { companyId, createdAt: { $gte: start, $lte: end }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
    { $unwind: '$items' },
    { $group: {
      _id: { productId: '$items.productId', name: '$items.name' },
      revenue: { $sum: { $multiply: [{ $ifNull: ['$items.price', 0] }, { $ifNull: ['$items.quantity', 0] }] } },
      quantity: { $sum: { $ifNull: ['$items.quantity', 0] } },
    } },
  ]);
  return new Map(rows.map((r) => [r._id.name || String(r._id.productId), r]));
}

// ── GET /analytics/revenue ────────────────────────────────────────────────
exports.getRevenueAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const { start, end, prevStart, prevEnd, days, periodKey } = resolvePeriod(req);
    const { data, cached } = await withCache(cacheKey('revenue', companyId, periodKey), 600, async () => {
      const [current, previous, byProductNow, byProductPrev] = await Promise.all([
        computeRevenueForRange(companyId, start, end),
        computeRevenueForRange(companyId, prevStart, prevEnd),
        orderItemsRevenueByProduct(companyId, start, end),
        orderItemsRevenueByProduct(companyId, prevStart, prevEnd),
      ]);

      // Daily series — invoices by paidAt, orders by createdAt, merged.
      const buckets = dailyBuckets(start, end);
      const dayMap = new Map(buckets.map((d) => [dateKey(d), 0]));
      const [invoicesByDay, ordersByDay] = await Promise.all([
        Invoice.aggregate([
          { $match: { companyId, status: 'paid', paidAt: { $gte: start, $lte: end } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } }, total: { $sum: { $ifNull: ['$ngnEquivalent', '$total'] } } } },
        ]),
        Order.aggregate([
          { $match: { companyId, createdAt: { $gte: start, $lte: end }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$total' } } },
        ]),
      ]);
      invoicesByDay.forEach((r) => dayMap.set(r._id, (dayMap.get(r._id) || 0) + r.total));
      ordersByDay.forEach((r) => dayMap.set(r._id, (dayMap.get(r._id) || 0) + r.total));
      const revenueByDay = [...dayMap.entries()].map(([date, amount]) => ({ date, amount: round2(amount) }));
      const topRevenueDay = revenueByDay.reduce((top, d) => (d.amount > (top?.amount || 0) ? d : top), null);

      // Last 6 calendar months, regardless of the selected period.
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);
      const [invoicesByMonth, ordersByMonth] = await Promise.all([
        Invoice.aggregate([
          { $match: { companyId, status: 'paid', paidAt: { $gte: sixMonthsAgo } } },
          { $group: { _id: { y: { $year: '$paidAt' }, m: { $month: '$paidAt' } }, total: { $sum: { $ifNull: ['$ngnEquivalent', '$total'] } } } },
        ]),
        Order.aggregate([
          { $match: { companyId, createdAt: { $gte: sixMonthsAgo }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
          { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, total: { $sum: '$total' } } },
        ]),
      ]);
      const monthTotal = (y, m) =>
        (invoicesByMonth.find((r) => r._id.y === y && r._id.m === m)?.total || 0) +
        (ordersByMonth.find((r) => r._id.y === y && r._id.m === m)?.total || 0);
      const revenueByMonth = [];
      const mc = new Date(sixMonthsAgo);
      for (let i = 0; i < 6; i++) {
        revenueByMonth.push({ month: mc.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), amount: round2(monthTotal(mc.getFullYear(), mc.getMonth() + 1)) });
        mc.setMonth(mc.getMonth() + 1);
      }

      const revenueByProduct = [...byProductNow.entries()]
        .map(([name, r]) => {
          const prev = byProductPrev.get(name);
          return { name, revenue: round2(r.revenue), quantity: r.quantity, growth: pctChange(r.revenue, prev?.revenue || 0) };
        })
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 15);

      const averageOrderValue = current.orderCount ? round2((current.storeOrders + current.manual) / current.orderCount) : 0;
      const projectedRevenue = round2((current.total / days) * 30);

      return {
        totalRevenue: round2(current.total),
        revenueGrowth: pctChange(current.total, previous.total),
        revenueByDay,
        revenueByMonth,
        revenueBySource: { invoices: round2(current.invoices), storeOrders: round2(current.storeOrders), manual: round2(current.manual) },
        revenueByProduct,
        averageOrderValue,
        projectedRevenue,
        topRevenueDay: topRevenueDay || { date: null, amount: 0 },
      };
    });

    res.status(200).json({ success: true, data, cached });
  } catch (err) { next(err); }
};

// ── GET /analytics/customers ──────────────────────────────────────────────
exports.getCustomerAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const { start, end, prevStart, prevEnd, periodKey } = resolvePeriod(req);
    const { data, cached } = await withCache(cacheKey('customers', companyId, periodKey), 600, async () => {
      const [
        totalCustomers, newCustomers, prevNewCustomers,
        returningCustomers, allTimeReturning,
        ltvAgg, topCustomers, byLocation,
        staleCount,
        storeEmails, manualEmails, invoiceEmails,
      ] = await Promise.all([
        Customer.countDocuments({ companyId }),
        Customer.countDocuments({ companyId, createdAt: { $gte: start, $lte: end } }),
        Customer.countDocuments({ companyId, createdAt: { $gte: prevStart, $lte: prevEnd } }),
        Customer.countDocuments({ companyId, totalOrders: { $gt: 1 }, lastOrderAt: { $gte: start, $lte: end } }),
        Customer.countDocuments({ companyId, totalOrders: { $gt: 1 } }),
        Customer.aggregate([{ $match: { companyId } }, { $group: { _id: null, avg: { $avg: '$totalSpent' } } }]),
        Customer.find({ companyId }).sort({ totalSpent: -1 }).limit(10).select('name totalSpent totalOrders lastOrderAt').lean(),
        Customer.aggregate([
          { $match: { companyId, city: { $nin: [null, ''] } } },
          { $group: { _id: { city: '$city', state: '$state' }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]),
        // "Churned" = hasn't ordered in 90+ days but has ordered at least once.
        Customer.countDocuments({ companyId, totalOrders: { $gte: 1 }, lastOrderAt: { $lt: new Date(Date.now() - 90 * DAY_MS) } }),
        Order.distinct('customer.email', { companyId, source: 'storefront' }),
        Order.distinct('customer.email', { companyId, source: { $ne: 'storefront' } }),
        Invoice.distinct('customer.email', { companyId }),
      ]);

      const storeSet = new Set(storeEmails.filter(Boolean).map((e) => e.toLowerCase()));
      const manualSet = new Set(manualEmails.filter(Boolean).map((e) => e.toLowerCase()));
      const invoiceSet = new Set(invoiceEmails.filter(Boolean).map((e) => e.toLowerCase()));
      const allCustomerEmails = await Customer.find({ companyId, email: { $nin: [null, ''] } }).select('email').lean();
      const acquisitionBySource = { store: 0, manual: 0, invoice: 0 };
      allCustomerEmails.forEach(({ email }) => {
        const e = email.toLowerCase();
        if (storeSet.has(e)) acquisitionBySource.store += 1;
        else if (manualSet.has(e)) acquisitionBySource.manual += 1;
        else if (invoiceSet.has(e)) acquisitionBySource.invoice += 1;
      });

      const tierOf = (spent) => (spent >= 500000 ? 'Platinum' : spent >= 200000 ? 'Gold' : spent >= 50000 ? 'Silver' : 'Bronze');

      return {
        totalCustomers,
        newCustomers,
        returningCustomers,
        customerGrowth: pctChange(newCustomers, prevNewCustomers),
        churnRate: totalCustomers ? round2((staleCount / totalCustomers) * 100) : 0,
        averageLifetimeValue: round2(ltvAgg[0]?.avg || 0),
        topCustomers: topCustomers.map((c) => ({
          name: c.name, totalSpent: c.totalSpent, orderCount: c.totalOrders, lastOrderDate: c.lastOrderAt, tier: tierOf(c.totalSpent),
        })),
        customersByLocation: byLocation.map((l) => ({ city: l._id.city || null, state: l._id.state || null, count: l.count })),
        acquisitionBySource,
        repeatPurchaseRate: totalCustomers ? round2((allTimeReturning / totalCustomers) * 100) : 0,
      };
    });

    res.status(200).json({ success: true, data, cached });
  } catch (err) { next(err); }
};

// ── GET /analytics/products ───────────────────────────────────────────────
exports.getProductAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const { start, end, periodKey } = resolvePeriod(req);
    const { data, cached } = await withCache(cacheKey('products', companyId, periodKey), 600, async () => {
      const [statusAgg, inventoryAgg, itemsAgg, allProducts, soldRecentIds] = await Promise.all([
        Product.aggregate([
          { $match: { companyId } },
          { $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            outOfStock: { $sum: { $cond: [{ $eq: ['$status', 'out_of_stock'] }, 1, 0] } },
            lowStock: { $sum: { $cond: [{ $and: [
              { $ne: ['$status', 'inactive'] }, { $eq: ['$stock.trackStock', true] },
              { $gt: ['$stock.quantity', 0] }, { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] },
            ] }, 1, 0] } },
          } },
        ]),
        Product.aggregate([
          { $match: { companyId, status: { $ne: 'inactive' } } },
          { $group: { _id: null, value: { $sum: { $multiply: [{ $ifNull: ['$costPrice', '$price'] }, '$stock.quantity'] } } } },
        ]),
        Order.aggregate([
          { $match: { companyId, createdAt: { $gte: start, $lte: end }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
          { $unwind: '$items' },
          { $match: { 'items.productId': { $ne: null } } },
          { $group: { _id: '$items.productId', sold: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }, lastSoldAt: { $max: '$createdAt' } } },
        ]),
        Product.find({ companyId, status: { $ne: 'inactive' } }).select('name category price stock images createdAt').lean(),
        null,
      ]);

      const soldMap = new Map(itemsAgg.map((r) => [String(r._id), r]));
      const productsById = new Map(allProducts.map((p) => [String(p._id), p]));

      const topSellingProducts = itemsAgg
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10)
        .map((r) => {
          const p = productsById.get(String(r._id));
          return {
            name: p?.name || 'Unknown product', sold: r.sold, revenue: round2(r.revenue),
            stock: p?.stock?.quantity ?? null, image: p?.images?.[0] || null, category: p?.category || null,
          };
        });

      const sixtyDaysAgo = new Date(Date.now() - 60 * DAY_MS);
      const slowMovingProducts = allProducts
        .filter((p) => (p.stock?.trackStock ? p.stock.quantity > 0 : false))
        .map((p) => {
          const sold = soldMap.get(String(p._id));
          return {
            name: p.name, lastSoldAt: sold?.lastSoldAt || null, stock: p.stock?.quantity ?? 0,
            daysInStock: Math.round((Date.now() - new Date(p.createdAt).getTime()) / DAY_MS),
          };
        })
        .filter((p) => !p.lastSoldAt || new Date(p.lastSoldAt) < sixtyDaysAgo)
        .sort((a, b) => new Date(a.lastSoldAt || 0) - new Date(b.lastSoldAt || 0))
        .slice(0, 10);

      const categoryMap = new Map();
      allProducts.forEach((p) => {
        const cat = p.category || 'Uncategorized';
        if (!categoryMap.has(cat)) categoryMap.set(cat, { category: cat, products: 0, revenue: 0, sold: 0 });
        categoryMap.get(cat).products += 1;
        const sold = soldMap.get(String(p._id));
        if (sold) { categoryMap.get(cat).revenue += sold.revenue; categoryMap.get(cat).sold += sold.sold; }
      });
      const categoryBreakdown = [...categoryMap.values()].map((c) => ({ ...c, revenue: round2(c.revenue) })).sort((a, b) => b.revenue - a.revenue);

      const stockAlerts = allProducts
        .filter((p) => p.stock?.trackStock && p.stock.quantity <= (p.stock.lowStockThreshold ?? 5))
        .map((p) => ({ name: p.name, stock: p.stock.quantity, threshold: p.stock.lowStockThreshold ?? 5, status: p.stock.quantity <= 0 ? 'out' : 'low' }))
        .sort((a, b) => a.stock - b.stock);

      return {
        totalProducts: statusAgg[0]?.total || 0,
        activeProducts: statusAgg[0]?.active || 0,
        outOfStock: statusAgg[0]?.outOfStock || 0,
        lowStock: statusAgg[0]?.lowStock || 0,
        totalInventoryValue: round2(inventoryAgg[0]?.value || 0),
        topSellingProducts,
        slowMovingProducts,
        categoryBreakdown,
        stockAlerts,
      };
    });

    res.status(200).json({ success: true, data, cached });
  } catch (err) { next(err); }
};

// ── GET /analytics/leads ──────────────────────────────────────────────────
const WON_STATUSES = ['won', 'converted'];
exports.getLeadAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const { start, end, periodKey } = resolvePeriod(req);
    const { data, cached } = await withCache(cacheKey('leads', companyId, periodKey), 600, async () => {
      const [
        totalLeads, newLeads, totalWon, totalLost, scoreAgg,
        statusAgg, sourceAgg, pipelineAgg, convertedTimeAgg, topPerformingLeads,
      ] = await Promise.all([
        Lead.countDocuments({ companyId }),
        Lead.countDocuments({ companyId, createdAt: { $gte: start, $lte: end } }),
        Lead.countDocuments({ companyId, status: { $in: WON_STATUSES } }),
        Lead.countDocuments({ companyId, status: 'lost' }),
        Lead.aggregate([{ $match: { companyId } }, { $group: { _id: null, avg: { $avg: '$score' } } }]),
        Lead.aggregate([{ $match: { companyId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Lead.aggregate([
          { $match: { companyId } },
          { $group: { _id: '$source', count: { $sum: 1 }, converted: { $sum: { $cond: [{ $in: ['$status', WON_STATUSES] }, 1, 0] } } } },
        ]),
        Lead.aggregate([
          { $match: { companyId, status: { $nin: [...WON_STATUSES, 'lost'] } } },
          { $group: { _id: null, value: { $sum: '$value' } } },
        ]),
        Lead.aggregate([
          { $match: { companyId, status: { $in: WON_STATUSES } } },
          { $project: { days: { $divide: [{ $subtract: ['$updatedAt', '$createdAt'] }, DAY_MS] } } },
          { $group: { _id: null, avgDays: { $avg: '$days' } } },
        ]),
        Lead.find({ companyId }).sort({ score: -1 }).limit(10).select('name score value').lean(),
      ]);

      const leadsByStatus = {};
      statusAgg.forEach((s) => { leadsByStatus[s._id] = s.count; });

      return {
        totalLeads,
        newLeads,
        convertedLeads: totalWon,
        conversionRate: totalLeads ? round2((totalWon / totalLeads) * 100) : 0,
        averageLeadScore: round2(scoreAgg[0]?.avg || 0),
        leadsByStatus,
        leadsBySource: sourceAgg.map((s) => ({ source: s._id, count: s.count, converted: s.converted })),
        averageTimeToConvert: round2(convertedTimeAgg[0]?.avgDays || 0),
        pipelineValue: round2(pipelineAgg[0]?.value || 0),
        winRate: (totalWon + totalLost) ? round2((totalWon / (totalWon + totalLost)) * 100) : 0,
        topPerformingLeads: topPerformingLeads.map((l) => ({ name: l.name, score: l.score, value: l.value })),
      };
    });

    res.status(200).json({ success: true, data, cached });
  } catch (err) { next(err); }
};

// ── GET /analytics/financial ───────────────────────────────────────────────
exports.getFinancialAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const { start, end, periodKey } = resolvePeriod(req);
    const { data, cached } = await withCache(cacheKey('financial', companyId, periodKey), 600, async () => {
      const now = new Date();
      const [revenue, expenseAgg, cogsAgg, expenseByCategory, outstandingAgg, overdueAgg] = await Promise.all([
        computeRevenueForRange(companyId, start, end),
        Expense.aggregate([
          { $match: { companyId, status: { $ne: 'rejected' }, date: { $gte: start, $lte: end } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        // Approximate cost of goods sold from sold items' costPrice.
        Order.aggregate([
          { $match: { companyId, createdAt: { $gte: start, $lte: end }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
          { $unwind: '$items' },
          { $match: { 'items.productId': { $ne: null } } },
          { $lookup: { from: 'products', localField: 'items.productId', foreignField: '_id', as: 'p' } },
          { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
          { $group: { _id: null, cogs: { $sum: { $multiply: [{ $ifNull: ['$p.costPrice', 0] }, '$items.quantity'] } } } },
        ]),
        Expense.aggregate([
          { $match: { companyId, status: { $ne: 'rejected' }, date: { $gte: start, $lte: end } } },
          { $group: { _id: '$category', amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ]),
        Invoice.aggregate([
          { $match: { companyId, status: { $in: ['sent', 'viewed', 'partial'] } } },
          { $group: { _id: null, total: { $sum: '$total' } } },
        ]),
        Invoice.aggregate([
          { $match: { companyId, status: { $in: ['sent', 'viewed', 'partial'] }, dueAt: { $lt: now } } },
          { $group: { _id: null, total: { $sum: '$total' } } },
        ]),
      ]);

      const expenses = expenseAgg[0]?.total || 0;
      const cogs = cogsAgg[0]?.cogs || 0;
      const grossProfit = revenue.total - cogs;
      const netProfit = grossProfit - expenses;
      const totalExpenseForPct = expenseByCategory.reduce((s, c) => s + c.amount, 0) || 1;

      // Last 6 calendar months of revenue/expenses for the cash-flow and
      // revenue-vs-expenses charts.
      const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5); sixMonthsAgo.setDate(1); sixMonthsAgo.setHours(0, 0, 0, 0);
      const [monthlyExpenses, monthlyInvoices, monthlyOrders] = await Promise.all([
        Expense.aggregate([
          { $match: { companyId, status: { $ne: 'rejected' }, date: { $gte: sixMonthsAgo } } },
          { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' } }, total: { $sum: '$amount' } } },
        ]),
        Invoice.aggregate([
          { $match: { companyId, status: 'paid', paidAt: { $gte: sixMonthsAgo } } },
          { $group: { _id: { y: { $year: '$paidAt' }, m: { $month: '$paidAt' } }, total: { $sum: { $ifNull: ['$ngnEquivalent', '$total'] } } } },
        ]),
        Order.aggregate([
          { $match: { companyId, createdAt: { $gte: sixMonthsAgo }, status: { $nin: NON_REVENUE_ORDER_STATUS } } },
          { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, total: { $sum: '$total' } } },
        ]),
      ]);
      const revenueOf = (y, m) => (monthlyInvoices.find((r) => r._id.y === y && r._id.m === m)?.total || 0) + (monthlyOrders.find((r) => r._id.y === y && r._id.m === m)?.total || 0);
      const expenseOf = (y, m) => monthlyExpenses.find((r) => r._id.y === y && r._id.m === m)?.total || 0;

      const cashFlow = [];
      const revenueVsExpenses = [];
      const mc = new Date(sixMonthsAgo);
      for (let i = 0; i < 6; i++) {
        const label = mc.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        const inflow = round2(revenueOf(mc.getFullYear(), mc.getMonth() + 1));
        const outflow = round2(expenseOf(mc.getFullYear(), mc.getMonth() + 1));
        cashFlow.push({ month: label, inflow, outflow, net: round2(inflow - outflow) });
        revenueVsExpenses.push({ month: label, revenue: inflow, expenses: outflow, profit: round2(inflow - outflow) });
        mc.setMonth(mc.getMonth() + 1);
      }

      return {
        revenue: round2(revenue.total),
        expenses: round2(expenses),
        grossProfit: round2(grossProfit),
        netProfit: round2(netProfit),
        profitMargin: revenue.total ? round2((netProfit / revenue.total) * 100) : 0,
        cashFlow,
        // A rough estimate only (not tax advice) — Nigerian CIT varies by
        // company turnover band; 20% is a reasonable mid-size-company default.
        expenseBreakdown: expenseByCategory.map((c) => ({ category: c._id, amount: round2(c.amount), percentage: round2((c.amount / totalExpenseForPct) * 100) })),
        revenueVsExpenses,
        taxLiability: netProfit > 0 ? round2(netProfit * 0.2) : 0,
        outstandingInvoices: round2(outstandingAgg[0]?.total || 0),
        overdueAmount: round2(overdueAgg[0]?.total || 0),
      };
    });

    res.status(200).json({ success: true, data, cached });
  } catch (err) { next(err); }
};

// ── GET /analytics/operational ────────────────────────────────────────────
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
exports.getOperationalAnalytics = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const { start, end, periodKey } = resolvePeriod(req);
    const { data, cached } = await withCache(cacheKey('operational', companyId, periodKey), 600, async () => {
      const [apptAgg, apptTimeAgg, orderAgg, deliveryAgg, invoiceAgg, paymentDaysAgg, team] = await Promise.all([
        Appointment.aggregate([
          { $match: { companyId, scheduledAt: { $gte: start, $lte: end } } },
          { $group: {
            _id: null, total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } },
            cancellation: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          } },
        ]),
        Appointment.aggregate([
          { $match: { companyId, scheduledAt: { $gte: start, $lte: end } } },
          { $group: { _id: { dow: { $dayOfWeek: '$scheduledAt' }, hour: { $hour: '$scheduledAt' } }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        Order.aggregate([
          { $match: { companyId, createdAt: { $gte: start, $lte: end } } },
          { $group: {
            _id: null, total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed', 'processing', 'shipped']] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $in: ['$status', NON_REVENUE_ORDER_STATUS] }, 1, 0] } },
          } },
        ]),
        Order.aggregate([
          { $match: { companyId, status: 'delivered', deliveredAt: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
          { $project: { days: { $divide: [{ $subtract: ['$deliveredAt', '$createdAt'] }, DAY_MS] } } },
          { $group: { _id: null, avgDays: { $avg: '$days' } } },
        ]),
        Invoice.aggregate([
          { $match: { companyId, createdAt: { $gte: start, $lte: end } } },
          { $group: {
            _id: null, total: { $sum: 1 },
            paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
            draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
            overdue: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['sent', 'viewed', 'partial']] }, { $lt: ['$dueAt', new Date()] }] }, 1, 0] } },
          } },
        ]),
        Invoice.aggregate([
          { $match: { companyId, status: 'paid', paidAt: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
          { $project: { days: { $divide: [{ $subtract: ['$paidAt', '$createdAt'] }, DAY_MS] } } },
          { $group: { _id: null, avgDays: { $avg: '$days' } } },
        ]),
        User.find({ companyId, status: 'active', role: { $in: ['company_owner', 'manager', 'employee'] } }).select('name role').lean(),
      ]);

      const busiest = apptTimeAgg[0];
      const orders = orderAgg[0] || { total: 0, delivered: 0, pending: 0, cancelled: 0 };
      const invoices = invoiceAgg[0] || { total: 0, paid: 0, draft: 0, overdue: 0 };
      const appt = apptAgg[0] || { total: 0, completed: 0, noShow: 0, cancellation: 0 };

      const teamProductivity = await Promise.all(team.map(async (u) => {
        const [tasksCompleted, leadsHandled] = await Promise.all([
          Appointment.countDocuments({ companyId, staff: u._id, status: 'completed', scheduledAt: { $gte: start, $lte: end } }),
          Lead.countDocuments({ companyId, assignedTo: u._id }),
        ]);
        return { member: u.name, role: u.role, tasksCompleted, leadsHandled };
      }));

      return {
        appointments: {
          total: appt.total, completed: appt.completed, noShow: appt.noShow, cancellation: appt.cancellation,
          completionRate: appt.total ? round2((appt.completed / appt.total) * 100) : 0,
          busiestDay: busiest ? DAY_NAMES[busiest._id.dow - 1] : null,
          busiestTime: busiest ? `${String(busiest._id.hour).padStart(2, '0')}:00` : null,
        },
        orders: {
          total: orders.total, delivered: orders.delivered, pending: orders.pending, cancelled: orders.cancelled,
          averageDeliveryDays: round2(deliveryAgg[0]?.avgDays || 0),
          deliverySuccessRate: orders.total ? round2((orders.delivered / orders.total) * 100) : 0,
        },
        invoices: {
          total: invoices.total, paid: invoices.paid, overdue: invoices.overdue, draft: invoices.draft,
          averagePaymentDays: round2(paymentDaysAgg[0]?.avgDays || 0),
          collectionRate: invoices.total ? round2((invoices.paid / invoices.total) * 100) : 0,
        },
        teamProductivity,
      };
    });

    res.status(200).json({ success: true, data, cached });
  } catch (err) { next(err); }
};

// ── GET /analytics/insights ────────────────────────────────────────────────
// Mounted at a path distinct from the existing, free, rule-based
// /analytics/insights (analyticsController.getAIInsights, relied on by
// Dashboard.jsx on every page load) — this one calls Groq and is cached for
// 6 hours specifically so it's never triggered by routine page loads.
function parseInsights(text) {
  const blocks = String(text || '')
    .split(/\n(?=\s*\d+\.\s*\[PRIORITY)/i)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.slice(0, 5).map((block) => {
    const priority = (block.match(/\[PRIORITY:\s*(HIGH|MEDIUM|LOW)\]/i)?.[1] || 'MEDIUM').toUpperCase();
    const title = (block.match(/\]\s*(.+)/)?.[1] || block.split('\n')[0]).trim();
    const action = (block.match(/Action:\s*([\s\S]*?)(?:\n\s*Impact:|$)/i)?.[1] || '').trim();
    const impact = (block.match(/Impact:\s*([\s\S]*)/i)?.[1] || '').trim();
    return { priority, title, action, impact };
  });
}

exports.getAIInsights = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const key = cacheKey('insights', companyId);
    const cached = cache.get(key);
    if (cached) return res.status(200).json({ success: true, data: cached, cached: true });

    const now = new Date();
    const start30 = new Date(now.getTime() - 30 * DAY_MS);
    const prevStart30 = new Date(now.getTime() - 60 * DAY_MS);

    const [revenueNow, revenuePrev, totalCustomers, newCustomers, topProductRow, leadTotals, financials, lowStockCount] = await Promise.all([
      computeRevenueForRange(companyId, start30, now),
      computeRevenueForRange(companyId, prevStart30, start30),
      Customer.countDocuments({ companyId }),
      Customer.countDocuments({ companyId, createdAt: { $gte: start30 } }),
      orderItemsRevenueByProduct(companyId, start30, now).then((m) => [...m.entries()].sort((a, b) => b[1].revenue - a[1].revenue)[0]),
      Promise.all([
        Lead.countDocuments({ companyId }),
        Lead.countDocuments({ companyId, status: { $in: WON_STATUSES } }),
      ]),
      Expense.aggregate([
        { $match: { companyId, status: { $ne: 'rejected' }, date: { $gte: start30 } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Product.countDocuments({ companyId, status: { $ne: 'inactive' }, 'stock.trackStock': true, $expr: { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] } }),
      Invoice.aggregate([
        { $match: { companyId, status: { $in: ['sent', 'viewed', 'partial'] }, dueAt: { $lt: now } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]).then((r) => r[0]?.total || 0),
    ]);

    const revenueGrowth = pctChange(revenueNow.total, revenuePrev.total);
    const [totalLeads, wonLeads] = leadTotals;
    const conversionRate = totalLeads ? round2((wonLeads / totalLeads) * 100) : 0;
    const expenses = financials[0]?.total || 0;
    const netProfit = revenueNow.total - expenses;
    const profitMargin = revenueNow.total ? round2((netProfit / revenueNow.total) * 100) : 0;
    const overdueAmountValue = await Invoice.aggregate([
      { $match: { companyId, status: { $in: ['sent', 'viewed', 'partial'] }, dueAt: { $lt: now } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]).then((r) => r[0]?.total || 0);

    const prompt = `You are a business analyst.
Analyze this Nigerian business data and provide
5 specific, actionable recommendations:

Revenue: ₦${Math.round(revenueNow.total).toLocaleString()} (${revenueGrowth}% growth)
Customers: ${totalCustomers} (${newCustomers} new)
Top product: ${topProductRow ? `${topProductRow[0]} (₦${Math.round(topProductRow[1].revenue).toLocaleString()})` : 'Not available'}
Conversion rate: ${conversionRate}%
Profit margin: ${profitMargin}%
Overdue invoices: ₦${Math.round(overdueAmountValue).toLocaleString()}
Low stock products: ${lowStockCount}

Provide exactly 5 recommendations in this format:
1. [PRIORITY: HIGH/MEDIUM/LOW] Title
   Action: Specific thing to do
   Impact: Expected result

Focus on Nigerian business context.
Plain text only, no markdown.`;

    const raw = await runAgent('analytics_agent', prompt, { useSmartModel: true, maxTokens: 900, temperature: 0.3 });
    const recommendations = parseInsights(raw);
    const payload = { recommendations, generatedAt: new Date() };

    cache.set(key, payload, 6 * 60 * 60); // 6 hours
    res.status(200).json({ success: true, data: payload, cached: false });
  } catch (err) { next(err); }
};
