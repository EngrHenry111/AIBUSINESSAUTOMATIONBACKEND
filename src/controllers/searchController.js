'use strict';

const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Appointment = require('../models/Appointment');
const Document = require('../models/Document');
const Meeting = require('../models/Meeting');

exports.globalSearch = async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(200).json({ success: true, data: [] });
    }

    const query = q.trim();
    const regex = { $regex: query, $options: 'i' };
    const companyId = req.companyId;
    const limit = 5;

    const [leads, invoices, orders, appointments, documents, meetings] = await Promise.all([
      Lead.find({ companyId, $or: [{ name: regex }, { email: regex }, { company: regex }] })
        .select('name email company status score').limit(limit),
      Invoice.find({ companyId, $or: [{ invoiceNumber: regex }, { 'customer.name': regex }] })
        .select('invoiceNumber customer total status dueAt').limit(limit),
      Order.find({ companyId, $or: [{ orderNumber: regex }, { 'customer.name': regex }] })
        .select('orderNumber customer total status').limit(limit),
      Appointment.find({ companyId, $or: [{ title: regex }, { 'customer.name': regex }] })
        .select('title customer scheduledAt status').limit(limit),
      Document.find({ companyId, $or: [{ name: regex }, { description: regex }] })
        .select('name fileType status createdAt').limit(limit),
      Meeting.find({ companyId, title: regex })
        .select('title scheduledAt status').limit(limit),
    ]);

    const results = [
      ...leads.map(l => ({ type: 'lead', id: l._id, title: l.name, subtitle: l.company || l.email, status: l.status, url: '/leads' })),
      ...invoices.map(i => ({ type: 'invoice', id: i._id, title: i.invoiceNumber, subtitle: i.customer?.name, status: i.status, url: '/invoices' })),
      ...orders.map(o => ({ type: 'order', id: o._id, title: o.orderNumber, subtitle: o.customer?.name, status: o.status, url: '/orders' })),
      ...appointments.map(a => ({ type: 'appointment', id: a._id, title: a.title, subtitle: a.customer?.name, status: a.status, url: '/appointments' })),
      ...documents.map(d => ({ type: 'document', id: d._id, title: d.name, subtitle: d.fileType?.toUpperCase(), status: d.status, url: '/knowledge' })),
      ...meetings.map(m => ({ type: 'meeting', id: m._id, title: m.title, subtitle: m.status, status: m.status, url: '/meetings' })),
    ];

    res.status(200).json({ success: true, data: results, query });
  } catch (err) { next(err); }
};
