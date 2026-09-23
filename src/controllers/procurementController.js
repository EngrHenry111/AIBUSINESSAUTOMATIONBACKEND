'use strict';

const fs = require('fs');
const Procurement = require('../models/Procurement');
const ProcurementBudget = require('../models/ProcurementBudget');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const { cloudinary } = require('../config/cloudinary');

const PREFIX_BY_TYPE = {
  purchase_requisition: 'PR', request_for_quotation: 'RFQ', purchase_order: 'PO',
  contract_award: 'CA', goods_receipt: 'GRN', payment_voucher: 'PV',
};
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Approval thresholds (NGN) — sequential, cannot be skipped ──────────────
function requiredApprovalRoles(amount) {
  if (amount < 100000) return ['Department Head'];
  if (amount <= 1000000) return ['Department Head', 'Finance Officer'];
  return ['Department Head', 'Finance Officer', 'MD/Director'];
}

async function nextReferenceNumber(companyId, type) {
  const prefix = PREFIX_BY_TYPE[type] || 'PR';
  const year = new Date().getFullYear();
  const count = await Procurement.countDocuments({ companyId, type, referenceNumber: { $regex: `^${prefix}/${year}/` } });
  return `${prefix}/${year}/${String(count + 1).padStart(3, '0')}`;
}

function pushAudit(procurement, { action, user, comment, ip }) {
  procurement.auditTrail.push({
    action, performedBy: user?._id, performedByName: user?.name, comment, ipAddress: ip, timestamp: new Date(),
  });
}

async function notifyUser(userId, subject, bodyHtml) {
  try {
    const user = await User.findById(userId).select('email name');
    if (!user?.email) return;
    await emailService.send({ to: user.email, subject, html: emailService.baseTemplate(subject, bodyHtml) });
  } catch (err) {
    logger.warn(`Procurement notification email failed: ${err.message}`);
  }
}

function emitRefresh(req, companyId) {
  const io = req.app.get('io');
  if (io) io.to(`company:${companyId}`).emit('notification:refresh', { type: 'procurement' });
}

// ── POST /procurement ─────────────────────────────────────────────────────
// Creates a draft (status stays 'draft', no approval chain yet) unless
// `submit: true` is sent, which builds the approval chain immediately and
// moves straight to pending_approval — matching the wizard's single
// "Submit for Approval" button while still giving the model's own 'draft'
// status somewhere real to come from.
exports.createRequisition = async (req, res, next) => {
  try {
    const {
      title, type = 'purchase_requisition', department, priority = 'medium',
      items = [], budgetCode, deliveryDate, deliveryLocation, notes,
      approvers = [], submit = false,
    } = req.body;

    if (!title?.trim()) return next(new AppError('Title is required.', 400));
    if (!Array.isArray(items) || items.length === 0) return next(new AppError('At least one item is required.', 400));

    const resolvedItems = items.map((i) => {
      const quantity = Number(i.quantity) || 0;
      const estimatedUnitPrice = Number(i.estimatedUnitPrice) || 0;
      return {
        description: i.description, quantity, unit: i.unit || 'pieces', estimatedUnitPrice,
        estimatedTotal: Math.round(quantity * estimatedUnitPrice * 100) / 100, category: i.category,
      };
    });
    const estimatedTotal = resolvedItems.reduce((s, i) => s + i.estimatedTotal, 0);

    let budget = null;
    if (budgetCode) {
      budget = await ProcurementBudget.findOne({ companyId: req.companyId, code: budgetCode, year: new Date().getFullYear() });
      if (!budget) return next(new AppError(`Budget code "${budgetCode}" not found for this year.`, 404));
      if (submit && estimatedTotal > budget.totalBudget - budget.allocated) {
        return next(new AppError(`This requisition (${naira(estimatedTotal)}) exceeds the available budget on "${budgetCode}" (${naira(budget.totalBudget - budget.allocated)} available).`, 400));
      }
    }

    const procurement = new Procurement({
      companyId: req.companyId,
      referenceNumber: await nextReferenceNumber(req.companyId, type),
      title: title.trim(), type, department, priority,
      requestedBy: req.user._id,
      items: resolvedItems,
      estimatedTotal,
      budget: budget ? { code: budget.code, description: budget.description, available: budget.totalBudget - budget.allocated, allocated: budget.allocated } : undefined,
      deliveryDate, deliveryLocation, notes,
      status: 'draft',
    });
    pushAudit(procurement, { action: 'created', user: req.user, ip: req.ip });

    if (submit) {
      const roles = requiredApprovalRoles(estimatedTotal);
      if (approvers.length !== roles.length) {
        return next(new AppError(`This requisition requires ${roles.length} approver(s) (${roles.join(', ')}) based on its value.`, 400));
      }
      const approverUsers = await User.find({ _id: { $in: approvers.map((a) => a.approverId) }, companyId: req.companyId }).select('name');
      const userMap = new Map(approverUsers.map((u) => [String(u._id), u]));
      procurement.approvalChain = approvers.map((a, i) => {
        const u = userMap.get(String(a.approverId));
        if (!u) throw new AppError('One of the selected approvers is not a member of your team.', 400);
        return { approverId: u._id, approverName: u.name, approverRole: roles[i], status: 'pending', order: i + 1 };
      });
      procurement.currentApprovalLevel = 1;
      procurement.status = 'pending_approval';
      pushAudit(procurement, { action: 'submitted for approval', user: req.user, ip: req.ip });
    }

    await procurement.save();

    if (submit) {
      const first = procurement.approvalChain[0];
      notifyUser(first.approverId, `Approval needed: ${procurement.referenceNumber}`, `
        <h2 style="color:#0f172a;margin:0 0 6px;">Purchase requisition awaiting your approval</h2>
        <p style="color:#475569;font-size:14px;"><strong>${esc(procurement.referenceNumber)}</strong> — ${esc(procurement.title)} (${naira(estimatedTotal)}), submitted by ${esc(req.user.name)}.</p>
      `).catch(() => {});
      emitRefresh(req, req.companyId);
    }

    res.status(201).json({ success: true, data: procurement });
  } catch (err) { next(err); }
};

// ── GET /procurement ───────────────────────────────────────────────────────
exports.getRequisitions = async (req, res, next) => {
  try {
    const { status, type, department, search, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (department) filter.department = department;
    if (search) filter.$or = [
      { referenceNumber: { $regex: search, $options: 'i' } },
      { title: { $regex: search, $options: 'i' } },
    ];

    const [requisitions, total] = await Promise.all([
      Procurement.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit))
        .select('-auditTrail -documents'),
      Procurement.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, data: requisitions, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

// ── GET /procurement/:id ───────────────────────────────────────────────────
exports.getRequisition = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!requisition) return next(new AppError('Requisition not found.', 404));

    // BPP due-process guidance: a genuine competitive procurement above
    // ₦100k should have at least 3 quotations on file — surfaced as a
    // soft warning, never a hard block (legitimate sole-sourcing exists).
    const complianceWarnings = [];
    if (requisition.estimatedTotal > 100000 && requisition.vendors.length < 3 && !['completed', 'cancelled'].includes(requisition.status)) {
      complianceWarnings.push('BPP guidance recommends at least 3 vendor quotations for procurements above ₦100,000.');
    }

    res.status(200).json({ success: true, data: { ...requisition, complianceWarnings } });
  } catch (err) { next(err); }
};

// ── PUT /procurement/:id ───────────────────────────────────────────────────
// Only drafts can be edited — a submitted requisition is a due-process
// record, not a document to keep rewriting. Passing submit:true on a draft
// is how the approval chain actually gets built (see createRequisition).
exports.updateRequisition = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!requisition) return next(new AppError('Requisition not found.', 404));
    if (requisition.status !== 'draft') return next(new AppError('Only draft requisitions can be edited.', 400));

    const { title, department, priority, items, budgetCode, deliveryDate, deliveryLocation, notes, approvers, submit } = req.body;
    if (title !== undefined) requisition.title = title;
    if (department !== undefined) requisition.department = department;
    if (priority !== undefined) requisition.priority = priority;
    if (deliveryDate !== undefined) requisition.deliveryDate = deliveryDate;
    if (deliveryLocation !== undefined) requisition.deliveryLocation = deliveryLocation;
    if (notes !== undefined) requisition.notes = notes;

    if (Array.isArray(items)) {
      requisition.items = items.map((i) => {
        const quantity = Number(i.quantity) || 0;
        const estimatedUnitPrice = Number(i.estimatedUnitPrice) || 0;
        return { description: i.description, quantity, unit: i.unit || 'pieces', estimatedUnitPrice, estimatedTotal: Math.round(quantity * estimatedUnitPrice * 100) / 100, category: i.category };
      });
      requisition.estimatedTotal = requisition.items.reduce((s, i) => s + i.estimatedTotal, 0);
    }

    let budget = null;
    if (budgetCode) {
      budget = await ProcurementBudget.findOne({ companyId: req.companyId, code: budgetCode, year: new Date().getFullYear() });
      if (!budget) return next(new AppError(`Budget code "${budgetCode}" not found for this year.`, 404));
      requisition.budget = { code: budget.code, description: budget.description, available: budget.totalBudget - budget.allocated, allocated: budget.allocated };
    }

    pushAudit(requisition, { action: 'updated', user: req.user, ip: req.ip });

    if (submit) {
      const roles = requiredApprovalRoles(requisition.estimatedTotal);
      const approverList = approvers || [];
      if (approverList.length !== roles.length) {
        return next(new AppError(`This requisition requires ${roles.length} approver(s) (${roles.join(', ')}) based on its value.`, 400));
      }
      if (budget && requisition.estimatedTotal > budget.totalBudget - budget.allocated) {
        return next(new AppError(`This requisition (${naira(requisition.estimatedTotal)}) exceeds the available budget (${naira(budget.totalBudget - budget.allocated)} available).`, 400));
      }
      const approverUsers = await User.find({ _id: { $in: approverList.map((a) => a.approverId) }, companyId: req.companyId }).select('name');
      const userMap = new Map(approverUsers.map((u) => [String(u._id), u]));
      requisition.approvalChain = approverList.map((a, i) => {
        const u = userMap.get(String(a.approverId));
        if (!u) throw new AppError('One of the selected approvers is not a member of your team.', 400);
        return { approverId: u._id, approverName: u.name, approverRole: roles[i], status: 'pending', order: i + 1 };
      });
      requisition.currentApprovalLevel = 1;
      requisition.status = 'pending_approval';
      pushAudit(requisition, { action: 'submitted for approval', user: req.user, ip: req.ip });
    }

    await requisition.save();

    if (submit) {
      const first = requisition.approvalChain[0];
      notifyUser(first.approverId, `Approval needed: ${requisition.referenceNumber}`, `
        <h2 style="color:#0f172a;margin:0 0 6px;">Purchase requisition awaiting your approval</h2>
        <p style="color:#475569;font-size:14px;"><strong>${esc(requisition.referenceNumber)}</strong> — ${esc(requisition.title)} (${naira(requisition.estimatedTotal)}).</p>
      `).catch(() => {});
      emitRefresh(req, req.companyId);
    }

    res.status(200).json({ success: true, data: requisition });
  } catch (err) { next(err); }
};

// ── POST /procurement/:id/approve ──────────────────────────────────────────
exports.approveRequisition = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!requisition) return next(new AppError('Requisition not found.', 404));
    if (requisition.status !== 'pending_approval') return next(new AppError('This requisition is not awaiting approval.', 400));

    const step = requisition.approvalChain.find((s) => s.order === requisition.currentApprovalLevel);
    if (!step) return next(new AppError('No pending approval step found.', 400));
    if (String(step.approverId) !== String(req.user._id)) {
      return next(new AppError('You are not the current approver for this requisition.', 403));
    }

    step.status = 'approved';
    step.comment = req.body.comment;
    step.actionedAt = new Date();
    pushAudit(requisition, { action: 'approved', user: req.user, comment: req.body.comment, ip: req.ip });

    const isFinal = requisition.currentApprovalLevel === requisition.approvalChain.length;
    if (isFinal) {
      requisition.status = 'approved';
      if (requisition.budget?.code) {
        await ProcurementBudget.updateOne(
          { companyId: req.companyId, code: requisition.budget.code, year: new Date().getFullYear() },
          { $inc: { allocated: requisition.estimatedTotal } },
        );
      }
      await requisition.save();
      notifyUser(requisition.requestedBy, `Approved: ${requisition.referenceNumber}`, `
        <h2 style="color:#0f172a;margin:0 0 6px;">Your requisition was fully approved ✅</h2>
        <p style="color:#475569;font-size:14px;"><strong>${esc(requisition.referenceNumber)}</strong> — ${esc(requisition.title)} has cleared every approval level.</p>
      `).catch(() => {});
    } else {
      requisition.currentApprovalLevel += 1;
      await requisition.save();
      const next2 = requisition.approvalChain.find((s) => s.order === requisition.currentApprovalLevel);
      notifyUser(next2.approverId, `Approval needed: ${requisition.referenceNumber}`, `
        <h2 style="color:#0f172a;margin:0 0 6px;">Purchase requisition awaiting your approval</h2>
        <p style="color:#475569;font-size:14px;"><strong>${esc(requisition.referenceNumber)}</strong> — ${esc(requisition.title)} (${naira(requisition.estimatedTotal)}) was approved by ${esc(step.approverName)} and now needs your sign-off.</p>
      `).catch(() => {});
    }

    emitRefresh(req, req.companyId);
    res.status(200).json({ success: true, data: requisition });
  } catch (err) { next(err); }
};

// ── POST /procurement/:id/reject ───────────────────────────────────────────
exports.rejectRequisition = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return next(new AppError('A rejection reason is required.', 400));

    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!requisition) return next(new AppError('Requisition not found.', 404));
    if (requisition.status !== 'pending_approval') return next(new AppError('This requisition is not awaiting approval.', 400));

    const step = requisition.approvalChain.find((s) => s.order === requisition.currentApprovalLevel);
    if (!step) return next(new AppError('No pending approval step found.', 400));
    if (String(step.approverId) !== String(req.user._id)) {
      return next(new AppError('You are not the current approver for this requisition.', 403));
    }

    step.status = 'rejected';
    step.comment = reason;
    step.actionedAt = new Date();
    requisition.status = 'rejected';
    pushAudit(requisition, { action: 'rejected', user: req.user, comment: reason, ip: req.ip });
    await requisition.save();

    notifyUser(requisition.requestedBy, `Rejected: ${requisition.referenceNumber}`, `
      <h2 style="color:#0f172a;margin:0 0 6px;">Your requisition was rejected</h2>
      <p style="color:#475569;font-size:14px;"><strong>${esc(requisition.referenceNumber)}</strong> — ${esc(requisition.title)} was rejected by ${esc(step.approverName)}.</p>
      <p style="color:#475569;font-size:14px;"><strong>Reason:</strong> ${esc(reason)}</p>
    `).catch(() => {});
    emitRefresh(req, req.companyId);

    res.status(200).json({ success: true, data: requisition });
  } catch (err) { next(err); }
};

// ── POST /procurement/:id/vendors ──────────────────────────────────────────
exports.addVendorQuotation = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!requisition) return next(new AppError('Requisition not found.', 404));

    const { name, email, phone, address, rcNumber, quotedPrice } = req.body;
    if (!name?.trim() || !quotedPrice) return next(new AppError('Vendor name and quoted price are required.', 400));

    let quotationDocument;
    if (req.file) {
      if (cloudinary) {
        const r = await cloudinary.uploader.upload(req.file.path, { folder: `business-ai/${req.companyId}/procurement`, resource_type: 'raw' });
        fs.unlink(req.file.path, () => {});
        quotationDocument = r.secure_url;
      } else {
        quotationDocument = `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${req.file.path.split(/[\\/]/).pop()}`;
      }
    }

    requisition.vendors.push({ name: name.trim(), email, phone, address, rcNumber, quotedPrice: Number(quotedPrice), quotationDocument });
    pushAudit(requisition, { action: `added vendor quotation (${name})`, user: req.user, ip: req.ip });
    await requisition.save();

    res.status(201).json({ success: true, data: requisition });
  } catch (err) { next(err); }
};

// ── POST /procurement/:id/select-vendor ────────────────────────────────────
exports.selectVendor = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!requisition) return next(new AppError('Requisition not found.', 404));

    const vendor = requisition.vendors.id(req.body.vendorId);
    if (!vendor) return next(new AppError('Vendor quotation not found.', 404));

    requisition.vendors.forEach((v) => { v.selected = String(v._id) === String(vendor._id); });
    requisition.selectedVendor = { name: vendor.name, email: vendor.email, amount: vendor.quotedPrice };
    pushAudit(requisition, { action: `selected vendor (${vendor.name})`, user: req.user, ip: req.ip });
    await requisition.save();

    res.status(200).json({ success: true, data: requisition });
  } catch (err) { next(err); }
};

// ── GET /procurement/:id/purchase-order ────────────────────────────────────
exports.generatePO = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!requisition) return next(new AppError('Requisition not found.', 404));
    if (!requisition.selectedVendor?.name) return next(new AppError('Select a winning vendor before generating a purchase order.', 400));

    const company = await Company.findById(req.companyId).select('companyName logo profile');
    const poNumber = requisition.referenceNumber.replace(/^[A-Z]+\//, 'PO/');

    const rows = requisition.items.map((i) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${esc(i.description)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;">${i.quantity} ${esc(i.unit)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${naira(i.actualUnitPrice ?? i.estimatedUnitPrice)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${naira(i.actualTotal ?? i.estimatedTotal)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>${esc(poNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1e293b; max-width: 820px; margin: 0 auto; padding: 40px 32px; }
  .letterhead { display:flex; align-items:center; gap:14px; border-bottom:3px double #1e293b; padding-bottom:16px; margin-bottom:20px; }
  .letterhead img { height: 46px; }
  .letterhead h2 { margin:0; font-size:18px; }
  .letterhead p { margin:2px 0 0; font-size:11.5px; color:#64748b; font-family:Arial,sans-serif; }
  h1 { text-align:center; font-size:20px; letter-spacing:0.08em; margin: 10px 0 2px; }
  .po-meta { display:flex; justify-content:space-between; font-family:Arial,sans-serif; font-size:12.5px; margin: 18px 0; }
  table { width:100%; border-collapse:collapse; margin: 18px 0; font-family:Arial,sans-serif; font-size:13px; }
  th { text-align:left; background:#f1f5f9; padding:8px 10px; font-size:11.5px; text-transform:uppercase; letter-spacing:0.04em; }
  .total-row td { font-weight:800; border-top:2px solid #1e293b; }
  .terms { font-family:Arial,sans-serif; font-size:12px; color:#475569; margin-top: 20px; }
  .sig { margin-top:50px; display:flex; justify-content:space-between; font-family:Arial,sans-serif; }
  .sig div { width:45%; }
  .sig .line { border-top:1px solid #1e293b; margin-top:44px; padding-top:6px; font-size:12px; }
  .stamp-area { width:120px; height:100px; border:1px dashed #94a3b8; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:10px; color:#94a3b8; font-family:Arial,sans-serif; margin-top:10px; }
  @media print { body { padding: 0; } }
</style></head>
<body>
  <div class="letterhead">
    ${company?.logo ? `<img src="${esc(company.logo)}" alt=""/>` : ''}
    <div><h2>${esc(company?.companyName || 'BizlyAI')}</h2>
    ${[company?.profile?.address, company?.profile?.email, company?.profile?.phone].filter(Boolean).map(esc).join(' · ') ? `<p>${[company?.profile?.address, company?.profile?.email, company?.profile?.phone].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
    </div>
  </div>
  <h1>PURCHASE ORDER</h1>
  <div class="po-meta">
    <div><strong>PO Number:</strong> ${esc(poNumber)}<br/><strong>Reference:</strong> ${esc(requisition.referenceNumber)}<br/><strong>Date:</strong> ${new Date().toLocaleDateString('en-GB')}</div>
    <div><strong>Vendor:</strong> ${esc(requisition.selectedVendor.name)}<br/>${requisition.selectedVendor.email ? esc(requisition.selectedVendor.email) : ''}</div>
  </div>
  <table>
    <thead><tr><th>Description</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th></tr></thead>
    <tbody>${rows}
      <tr class="total-row"><td colspan="3" style="padding:10px;">TOTAL</td><td style="padding:10px;text-align:right;">${naira(requisition.actualTotal ?? requisition.estimatedTotal)}</td></tr>
    </tbody>
  </table>
  <div class="terms">
    <p><strong>Terms:</strong> Net 30 days from date of delivery and invoice submission.</p>
    <p><strong>Delivery:</strong> ${esc(requisition.deliveryLocation || 'To be confirmed')}${requisition.deliveryDate ? ` by ${new Date(requisition.deliveryDate).toLocaleDateString('en-GB')}` : ''}.</p>
    <p>This purchase order is issued in accordance with the Bureau of Public Procurement (BPP) Act and the organisation's internal procurement policy. Goods/services must conform exactly to the specification above.</p>
  </div>
  <div class="sig">
    <div><div class="line">Authorized Procurement Officer</div></div>
    <div><div class="stamp-area">Official Stamp</div></div>
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) { next(err); }
};

// ── PATCH /procurement/:id/delivered ───────────────────────────────────────
exports.markDelivered = async (req, res, next) => {
  try {
    const requisition = await Procurement.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!requisition) return next(new AppError('Requisition not found.', 404));
    if (requisition.status !== 'approved') return next(new AppError('Only approved requisitions can be marked delivered.', 400));

    const { receivedBy, actualTotal } = req.body;
    if (!receivedBy?.trim()) return next(new AppError('Receiver name is required.', 400));

    requisition.receivedBy = receivedBy.trim();
    requisition.receivedAt = new Date();
    requisition.actualTotal = actualTotal != null ? Number(actualTotal) : requisition.estimatedTotal;
    requisition.status = 'completed';
    pushAudit(requisition, { action: 'goods received', user: req.user, comment: `Received by ${receivedBy}`, ip: req.ip });

    if (requisition.budget?.code) {
      await ProcurementBudget.updateOne(
        { companyId: req.companyId, code: requisition.budget.code, year: new Date().getFullYear() },
        { $inc: { spent: requisition.actualTotal } },
      );
    }

    await requisition.save();
    res.status(200).json({ success: true, data: requisition });
  } catch (err) { next(err); }
};

// ── GET /procurement/reports ────────────────────────────────────────────────
exports.generateReport = async (req, res, next) => {
  try {
    const { format = 'json' } = req.query;
    const companyId = req.companyId;

    const [byStatus, byType, byDepartment, budgets, vendors, all] = await Promise.all([
      Procurement.aggregate([{ $match: { companyId } }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$estimatedTotal' } } }]),
      Procurement.aggregate([{ $match: { companyId } }, { $group: { _id: '$type', count: { $sum: 1 }, value: { $sum: '$estimatedTotal' } } }]),
      Procurement.aggregate([{ $match: { companyId, department: { $nin: [null, ''] } } }, { $group: { _id: '$department', count: { $sum: 1 }, value: { $sum: '$estimatedTotal' } } }]),
      ProcurementBudget.find({ companyId, year: new Date().getFullYear() }).lean(),
      Vendor.find({ companyId }).select('name rating totalOrders totalValue isPrequalified blacklisted').sort({ totalValue: -1 }).lean(),
      Procurement.find({ companyId }).select('referenceNumber title type status department estimatedTotal actualTotal createdAt').sort({ createdAt: -1 }).lean(),
    ]);

    if (format === 'csv') {
      const headers = ['referenceNumber', 'title', 'type', 'status', 'department', 'estimatedTotal', 'actualTotal', 'createdAt'];
      const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [headers.join(','), ...all.map((r) => headers.map((h) => escCsv(r[h])).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="procurement-report.csv"');
      return res.send(csv);
    }

    res.status(200).json({
      success: true,
      data: {
        activity: { byStatus, byType, byDepartment, totalRequisitions: all.length },
        budgetUtilization: budgets.map((b) => ({
          code: b.code, department: b.department, totalBudget: b.totalBudget, allocated: b.allocated, spent: b.spent,
          available: b.totalBudget - b.allocated, utilizationPercent: b.totalBudget ? Math.round((b.allocated / b.totalBudget) * 100) : 0,
        })),
        vendorPerformance: vendors,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /procurement/budgets ────────────────────────────────────────────────
exports.getBudgets = async (req, res, next) => {
  try {
    const budgets = await ProcurementBudget.find({ companyId: req.companyId }).sort({ year: -1, department: 1 });
    res.status(200).json({ success: true, data: budgets });
  } catch (err) { next(err); }
};

// ── POST /procurement/budgets ───────────────────────────────────────────────
exports.createBudget = async (req, res, next) => {
  try {
    const { year, department, code, description, totalBudget, currency } = req.body;
    if (!code?.trim() || !totalBudget) return next(new AppError('Budget code and total amount are required.', 400));

    const budget = await ProcurementBudget.create({
      companyId: req.companyId, year: year || new Date().getFullYear(), department, code: code.trim(), description,
      totalBudget: Number(totalBudget), currency: currency || 'NGN',
    });
    res.status(201).json({ success: true, data: budget });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('A budget line with this code already exists for this year.', 409));
    next(err);
  }
};

// ── GET /procurement/vendors ────────────────────────────────────────────────
exports.getVendors = async (req, res, next) => {
  try {
    const { search, prequalified, blacklisted } = req.query;
    const filter = { companyId: req.companyId };
    if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { category: { $regex: search, $options: 'i' } }];
    if (prequalified === 'true') filter.isPrequalified = true;
    if (blacklisted === 'true') filter.blacklisted = true;

    const vendors = await Vendor.find(filter).sort({ name: 1 });
    res.status(200).json({ success: true, data: vendors });
  } catch (err) { next(err); }
};

// ── POST /procurement/vendors ───────────────────────────────────────────────
exports.createVendor = async (req, res, next) => {
  try {
    const { name, email, phone, address, rcNumber, tinNumber, category, bankName, accountNumber, accountName, notes } = req.body;
    if (!name?.trim()) return next(new AppError('Vendor name is required.', 400));

    const vendor = await Vendor.create({
      companyId: req.companyId, name: name.trim(), email, phone, address, rcNumber, tinNumber,
      category: Array.isArray(category) ? category : (category ? [category] : []),
      bankName, accountNumber, accountName, notes, createdBy: req.user._id,
    });
    res.status(201).json({ success: true, data: vendor });
  } catch (err) { next(err); }
};
