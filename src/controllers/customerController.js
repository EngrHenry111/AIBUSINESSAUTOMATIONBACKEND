'use strict';

const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Lead = require('../models/Lead');
const Order = require('../models/Order');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const cache = require('../utils/cache');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── GET /customers ────────────────────────────────────────────────────
exports.getCustomers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 25);
    const { search, status, type, sort = 'createdAt', order = 'desc' } = req.query;

    const q = { companyId: req.companyId };
    if (status) q.status = status;
    if (type) q.type = type;
    if (search && search.trim()) {
      const rx = { $regex: esc(search.trim()), $options: 'i' };
      q.$or = [{ name: rx }, { email: rx }, { phone: rx }, { company: rx }];
    }

    const sortField = ['name', 'totalSpent', 'lastOrderAt', 'createdAt', 'totalOrders'].includes(sort) ? sort : 'createdAt';
    const sortSpec = { [sortField]: order === 'asc' ? 1 : -1 };

    const [customers, total] = await Promise.all([
      Customer.find(q).sort(sortSpec).skip((page - 1) * limit).limit(limit).lean(),
      Customer.countDocuments(q),
    ]);

    res.status(200).json({
      success: true,
      data: customers,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) { next(err); }
};

// ── GET /customers/stats ──────────────────────────────────────────────
exports.getCustomerStats = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [total, active, newThisMonth, repeat, topSpenders] = await Promise.all([
      Customer.countDocuments({ companyId }),
      Customer.countDocuments({ companyId, status: 'active' }),
      Customer.countDocuments({ companyId, createdAt: { $gte: startOfMonth } }),
      Customer.countDocuments({ companyId, totalOrders: { $gte: 2 } }),
      Customer.find({ companyId }).sort({ totalSpent: -1 }).limit(5)
        .select('name email totalSpent totalOrders').lean(),
    ]);

    res.status(200).json({
      success: true,
      data: { total, active, newThisMonth, repeatCustomers: repeat, topSpenders },
    });
  } catch (err) { next(err); }
};

// ── GET /customers/:id ────────────────────────────────────────────────
exports.getCustomer = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return next(new AppError('Customer not found.', 404));
    const customer = await Customer.findOne({ _id: req.params.id, companyId: req.companyId })
      .populate('createdBy', 'name')
      .populate('convertedFromLead', 'name status')
      .lean();
    if (!customer) return next(new AppError('Customer not found.', 404));

    const emailMatch = customer.email
      ? { $regex: `^${esc(customer.email)}$`, $options: 'i' }
      : '__no_email__';

    const [orders, invoices, appointments] = await Promise.all([
      Order.find({ companyId: req.companyId, 'customer.email': emailMatch })
        .select('orderNumber status total currency items createdAt').sort({ createdAt: -1 }).limit(100).lean(),
      Invoice.find({ companyId: req.companyId, 'customer.email': emailMatch })
        .select('invoiceNumber status total currency dueAt issuedAt createdAt').sort({ createdAt: -1 }).limit(100).lean(),
      Appointment.find({ companyId: req.companyId, 'customer.email': emailMatch })
        .select('title status scheduledAt duration').sort({ scheduledAt: -1 }).limit(100).lean(),
    ]);

    // Activity timeline (merged, newest first)
    const activity = [
      ...orders.map((o) => ({ type: 'order', label: `Order ${o.orderNumber}`, meta: o.status, amount: o.total, currency: o.currency, at: o.createdAt })),
      ...invoices.map((i) => ({ type: 'invoice', label: `Invoice ${i.invoiceNumber}`, meta: i.status, amount: i.total, currency: i.currency, at: i.createdAt })),
      ...appointments.map((a) => ({ type: 'appointment', label: a.title || 'Appointment', meta: a.status, at: a.scheduledAt })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    const avgOrder = orders.length ? orders.reduce((s, o) => s + (o.total || 0), 0) / orders.length : 0;

    res.status(200).json({
      success: true,
      data: { ...customer, orders, invoices, appointments, activity, avgOrder },
    });
  } catch (err) { next(err); }
};

// ── POST /customers ───────────────────────────────────────────────────
exports.createCustomer = async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (!body.name || !body.name.trim()) return next(new AppError('Customer name is required.', 400));
    if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);

    const customer = await Customer.create({ ...body, companyId: req.companyId, createdBy: req.user._id });
    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'customer.create', resource: 'Customer', resourceId: customer._id, description: customer.name, ip: req.ip });
    res.status(201).json({ success: true, data: customer });
  } catch (err) { next(err); }
};

// ── PUT /customers/:id ────────────────────────────────────────────────
exports.updateCustomer = async (req, res, next) => {
  try {
    const body = { ...req.body };
    delete body.companyId; delete body.totalOrders; delete body.totalSpent;
    if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);

    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      body,
      { new: true, runValidators: true },
    );
    if (!customer) return next(new AppError('Customer not found.', 404));
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'customer.update', resource: 'Customer', resourceId: customer._id, ip: req.ip });
    res.status(200).json({ success: true, data: customer });
  } catch (err) { next(err); }
};

// ── DELETE /customers/:id (soft) ─────────────────────────────────────
exports.deleteCustomer = async (req, res, next) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      { status: 'inactive' },
      { new: true },
    );
    if (!customer) return next(new AppError('Customer not found.', 404));
    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'customer.delete', resource: 'Customer', resourceId: customer._id, ip: req.ip });
    res.status(200).json({ success: true, message: 'Customer archived.' });
  } catch (err) { next(err); }
};

// ── POST /customers/convert/:leadId ─────────────────────────────────
exports.convertLead = async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.leadId, companyId: req.companyId });
    if (!lead) return next(new AppError('Lead not found.', 404));

    let customer = null;
    if (lead.email) {
      customer = await Customer.findOne({ companyId: req.companyId, email: lead.email.toLowerCase() });
    }
    if (!customer) {
      customer = await Customer.create({
        companyId: req.companyId,
        name: lead.name,
        email: lead.email || undefined,
        phone: lead.phone || undefined,
        company: lead.company || undefined,
        type: lead.company ? 'business' : 'individual',
        tags: lead.tags || [],
        notes: lead.description || undefined,
        convertedFromLead: lead._id,
        createdBy: req.user._id,
      });
    } else if (!customer.convertedFromLead) {
      customer.convertedFromLead = lead._id;
      await customer.save();
    }

    lead.status = 'converted';
    lead.activities.push({ type: 'status_change', description: 'Converted to customer', performedBy: req.user._id });
    await lead.save();

    cache.del(`dashboard_${req.companyId}`);
    writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'lead.convert', resource: 'Customer', resourceId: customer._id, description: `Converted lead ${lead.name}`, ip: req.ip });
    res.status(200).json({ success: true, data: customer });
  } catch (err) { next(err); }
};
