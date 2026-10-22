'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const GroupStockItem = require('../models/GroupStockItem');
const GroupStockMove = require('../models/GroupStockMove');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { moveStock } = require('../utils/groupPosting');
const { helpers } = require('./groupController');

const { isGroupLevel, userBranchRole, visibleBranches, loadBranch } = helpers;
const num = (v) => Number(v) || 0;

// Who may change stock: the owner, or the manager / a department head of that branch.
function canManage(branch, user) {
  return ['owner', 'manager', 'head'].includes(userBranchRole(branch, user));
}

async function loadItem(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Stock item not found.', 404);
  const item = await GroupStockItem.findOne({ _id: id, companyId: req.companyId });
  if (!item) throw new AppError('Stock item not found.', 404);
  const branch = await loadBranch(req, item.branchId);
  return { item, branch };
}

// GET /group/stock?branchId=
exports.list = async (req, res, next) => {
  try {
    const branches = await visibleBranches(req);
    const ids = branches.map((b) => b._id);
    const q = { companyId: req.companyId, branchId: { $in: ids } };
    if (req.query.branchId) q.branchId = ids.find((id) => String(id) === String(req.query.branchId)) || null;
    if (req.query.active !== 'all') q.active = true;
    const items = await GroupStockItem.find(q).sort({ name: 1 }).lean();
    const names = new Map(branches.map((b) => [String(b._id), b.name]));
    const data = items.map((it) => ({
      ...it,
      branchName: names.get(String(it.branchId)),
      stockValue: Math.round(it.quantity * it.costPrice),
      low: it.reorderLevel > 0 && it.quantity <= it.reorderLevel,
    }));
    res.json({
      success: true,
      data,
      summary: {
        items: data.length,
        stockValue: data.reduce((s, x) => s + Math.max(0, x.stockValue), 0),
        lowStock: data.filter((x) => x.low).length,
        outOfStock: data.filter((x) => x.quantity <= 0).length,
      },
    });
  } catch (err) { next(err); }
};

// POST /group/stock  { branchId, name, unit, costPrice, sellingPrice, reorderLevel, openingQty }
exports.create = async (req, res, next) => {
  try {
    const branch = await loadBranch(req, req.body.branchId);
    if (!canManage(branch, req.user)) return next(new AppError('Only the owner or this branch\'s manager can add stock items.', 403));
    const name = String(req.body.name || '').trim();
    if (!name) return next(new AppError('Give the item a name.', 400));
    const item = await GroupStockItem.create({
      companyId: req.companyId, branchId: branch._id, name,
      sku: String(req.body.sku || '').trim(), unit: String(req.body.unit || 'pcs').trim(),
      department: String(req.body.department || '').trim(),
      costPrice: num(req.body.costPrice), sellingPrice: num(req.body.sellingPrice), reorderLevel: num(req.body.reorderLevel),
      quantity: 0,
    });
    const opening = num(req.body.openingQty);
    if (opening) await moveStock(item, { type: 'opening', qty: opening, unitCost: item.costPrice, by: req.user.name, note: 'Opening stock' });
    res.status(201).json({ success: true, data: await GroupStockItem.findById(item._id) });
  } catch (err) { next(err); }
};

// PUT /group/stock/:id — details only; quantity changes go through movements.
exports.update = async (req, res, next) => {
  try {
    const { item, branch } = await loadItem(req, req.params.id);
    if (!canManage(branch, req.user)) return next(new AppError('Not allowed.', 403));
    ['name', 'sku', 'unit', 'department'].forEach((k) => { if (req.body[k] !== undefined) item[k] = String(req.body[k]).trim(); });
    ['costPrice', 'sellingPrice', 'reorderLevel'].forEach((k) => { if (req.body[k] !== undefined) item[k] = Math.max(0, num(req.body[k])); });
    if (req.body.active !== undefined) item.active = Boolean(req.body.active);
    await item.save();
    res.json({ success: true, data: item });
  } catch (err) { next(err); }
};

// POST /group/stock/:id/receive  { qty, unitCost, supplier, reference, note }
exports.receive = async (req, res, next) => {
  try {
    const { item, branch } = await loadItem(req, req.params.id);
    if (!canManage(branch, req.user)) return next(new AppError('Not allowed.', 403));
    const qty = num(req.body.qty);
    if (qty <= 0) return next(new AppError('Enter the quantity received.', 400));
    const unitCost = req.body.unitCost !== undefined && req.body.unitCost !== '' ? num(req.body.unitCost) : item.costPrice;
    // Weighted average cost, so profit uses what the stock really cost.
    const onHand = Math.max(0, item.quantity);
    if (unitCost && (onHand + qty) > 0) {
      item.costPrice = Math.round(((onHand * item.costPrice + qty * unitCost) / (onHand + qty)) * 100) / 100;
      await item.save();
    }
    const updated = await moveStock(item, {
      type: 'receive', qty, unitCost, by: req.user.name,
      extra: { supplier: String(req.body.supplier || '').trim() },
      reference: String(req.body.reference || '').trim(), note: String(req.body.note || '').trim(),
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

// POST /group/stock/:id/adjust  { qty (signed), reason }
exports.adjust = async (req, res, next) => {
  try {
    const { item, branch } = await loadItem(req, req.params.id);
    if (!canManage(branch, req.user)) return next(new AppError('Not allowed.', 403));
    const qty = num(req.body.qty);
    const reason = String(req.body.reason || '').trim();
    if (!qty) return next(new AppError('Enter how much to add or remove.', 400));
    if (!reason) return next(new AppError('Give a reason (damaged, expired, returned…).', 400));
    const updated = await moveStock(item, { type: 'adjust', qty, unitCost: item.costPrice, by: req.user.name, note: reason });
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.stock_adjust', description: `${item.name}: ${qty} (${reason})`, ip: req.ip });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

// POST /group/stock/:id/transfer  { toBranchId, qty, note }
exports.transfer = async (req, res, next) => {
  try {
    const { item, branch } = await loadItem(req, req.params.id);
    if (!canManage(branch, req.user)) return next(new AppError('Not allowed.', 403));
    const to = await loadBranch(req, req.body.toBranchId);
    if (String(to._id) === String(branch._id)) return next(new AppError('Choose a different branch.', 400));
    const qty = num(req.body.qty);
    if (qty <= 0) return next(new AppError('Enter the quantity to transfer.', 400));
    if (qty > item.quantity) return next(new AppError(`Only ${item.quantity.toLocaleString()} ${item.unit} in stock.`, 400));

    // Same item at the receiving branch (matched by name), created if new there.
    let dest = await GroupStockItem.findOne({ companyId: req.companyId, branchId: to._id, name: item.name });
    if (!dest) {
      dest = await GroupStockItem.create({
        companyId: req.companyId, branchId: to._id, name: item.name, sku: item.sku, unit: item.unit,
        department: item.department, costPrice: item.costPrice, sellingPrice: item.sellingPrice, reorderLevel: item.reorderLevel,
      });
    }
    const transferId = crypto.randomUUID();
    const note = String(req.body.note || '').trim();
    await moveStock(item, { type: 'transfer_out', qty: -qty, unitCost: item.costPrice, by: req.user.name, note: `To ${to.name}${note ? ` · ${note}` : ''}`, extra: { transferId } });
    await moveStock(dest, { type: 'transfer_in', qty, unitCost: item.costPrice, by: req.user.name, note: `From ${branch.name}${note ? ` · ${note}` : ''}`, extra: { transferId } });
    res.json({ success: true, message: `Moved ${qty} ${item.unit} to ${to.name}` });
  } catch (err) { next(err); }
};

// POST /group/stock/count  { branchId, counts: [{ itemId, countedQty }], note }
// Physical stock count: the difference between books and shelf is posted as
// a 'count' movement and reported as loss (or surplus) in value.
exports.count = async (req, res, next) => {
  try {
    const branch = await loadBranch(req, req.body.branchId);
    if (!canManage(branch, req.user)) return next(new AppError('Not allowed.', 403));
    const counts = (req.body.counts || []).filter((c) => mongoose.isValidObjectId(c.itemId) && c.countedQty !== '' && c.countedQty != null);
    if (!counts.length) return next(new AppError('Enter at least one counted quantity.', 400));
    const items = await GroupStockItem.find({ _id: { $in: counts.map((c) => c.itemId) }, branchId: branch._id });
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const results = [];
    for (const c of counts) {
      const item = byId.get(String(c.itemId));
      if (!item) continue;
      const counted = num(c.countedQty);
      const diff = Math.round((counted - item.quantity) * 1000) / 1000;
      const systemQty = item.quantity;
      if (diff) {
        // eslint-disable-next-line no-await-in-loop
        await moveStock(item, {
          type: 'count', qty: diff, unitCost: item.costPrice, by: req.user.name,
          note: String(req.body.note || '').trim() || 'Stock count', extra: { systemQty, countedQty: counted },
        });
      }
      results.push({ itemId: item._id, name: item.name, unit: item.unit, systemQty, countedQty: counted, difference: diff, value: Math.round(diff * item.costPrice) });
    }
    const loss = results.filter((r) => r.difference < 0).reduce((s, r) => s + r.value, 0);
    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'group.stock_count', description: `${branch.name}: ${results.length} items, value difference ₦${Math.round(loss).toLocaleString()}`, ip: req.ip });
    res.json({ success: true, data: { results, lossValue: loss } });
  } catch (err) { next(err); }
};

// GET /group/stock/moves?branchId=&itemId=&type=&from=&to=
exports.moves = async (req, res, next) => {
  try {
    const branches = await visibleBranches(req);
    const ids = branches.map((b) => b._id);
    const q = { companyId: req.companyId, branchId: { $in: ids } };
    if (req.query.branchId) q.branchId = ids.find((id) => String(id) === String(req.query.branchId)) || null;
    if (req.query.itemId && mongoose.isValidObjectId(req.query.itemId)) q.itemId = req.query.itemId;
    if (req.query.type) q.type = req.query.type;
    if (req.query.from || req.query.to) {
      q.date = {};
      if (req.query.from) q.date.$gte = new Date(`${req.query.from}T00:00:00.000Z`);
      if (req.query.to) q.date.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
    }
    const moves = await GroupStockMove.find(q).sort({ date: -1, createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 200, 500)).lean();
    const names = new Map(branches.map((b) => [String(b._id), b.name]));
    res.json({ success: true, data: moves.map((m) => ({ ...m, branchName: names.get(String(m.branchId)) })) });
  } catch (err) { next(err); }
};

exports.canManage = canManage;
exports.isGroupLevel = isGroupLevel;
