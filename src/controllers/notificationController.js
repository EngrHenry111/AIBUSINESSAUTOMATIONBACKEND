'use strict';

const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const Appointment = require('../models/Appointment');
const Order = require('../models/Order');
const Message = require('../models/Message');
const Product = require('../models/Product');
const cache = require('../utils/cache');

exports.getNotifications = async (req, res, next) => {
  try {
    const companyId = req.companyId;
    const userId = req.user._id;

    const cacheKey = `notifications_${userId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, ...cached, cached: true });

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const in7Days = new Date(today); in7Days.setDate(in7Days.getDate() + 7);

    const [overdueInvoices, todayAppointments, newLeads,
      pendingOrders, unreadMessages, lowStockProducts] = await Promise.all([
      Invoice.find({ companyId, status: { $in: ['sent', 'viewed'] }, dueAt: { $lt: now } })
        .select('invoiceNumber customer total dueAt').limit(5),
      Appointment.find({ companyId, scheduledAt: { $gte: today, $lt: tomorrow }, status: { $in: ['confirmed', 'pending'] } })
        .select('title customer scheduledAt').limit(5),
      Lead.find({ companyId, createdAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } })
        .select('name company createdAt').limit(5),
      Order.find({ companyId, status: { $in: ['pending', 'confirmed'] }, createdAt: { $gte: new Date(now - 48 * 60 * 60 * 1000) } })
        .select('orderNumber customer status source total currency').limit(8),
      Message.countDocuments({ companyId, recipientId: userId, isRead: false }),
      Product.find({
        companyId, status: { $ne: 'inactive' }, 'stock.trackStock': true,
        $expr: { $lte: ['$stock.quantity', '$stock.lowStockThreshold'] },
      }).select('name stock updatedAt').limit(10),
    ]);

    const notifications = [
      ...overdueInvoices.map(inv => ({
        id: `inv-${inv._id}`, type: 'warning',
        title: 'Invoice Overdue',
        message: `Invoice ${inv.invoiceNumber} from ${inv.customer?.name} is overdue`,
        url: '/invoices', time: inv.dueAt,
      })),
      ...todayAppointments.map(apt => ({
        id: `apt-${apt._id}`, type: 'info',
        title: 'Appointment Today',
        message: `${apt.title} with ${apt.customer?.name || 'customer'}`,
        url: '/appointments', time: apt.scheduledAt,
      })),
      ...newLeads.map(lead => ({
        id: `lead-${lead._id}`, type: 'success',
        title: 'New Lead',
        message: `${lead.name}${lead.company ? ` from ${lead.company}` : ''} was added`,
        url: '/leads', time: lead.createdAt,
      })),
      ...pendingOrders.map(order => (order.source === 'storefront' ? {
        id: `order-${order._id}`, type: 'success',
        title: 'New Store Order',
        message: `${order.customer?.name || 'A customer'} ordered ${order.currency === 'NGN' ? '₦' : ''}${Number(order.total || 0).toLocaleString()} (${order.orderNumber})`,
        url: '/orders', time: order.createdAt,
      } : {
        id: `order-${order._id}`, type: 'info',
        title: 'Order Pending',
        message: `Order ${order.orderNumber} from ${order.customer?.name} needs attention`,
        url: '/orders', time: order.createdAt,
      })),
      ...lowStockProducts.map(p => ({
        id: `stock-${p._id}`, type: p.stock.quantity <= 0 ? 'warning' : 'info',
        title: p.stock.quantity <= 0 ? 'Out of Stock' : 'Low Stock',
        message: p.stock.quantity <= 0
          ? `${p.name} is out of stock`
          : `${p.name} is running low (${p.stock.quantity} left)`,
        url: '/products?status=low_stock', time: p.updatedAt,
      })),
    ];

    // Sort by time descending
    notifications.sort((a, b) => new Date(b.time) - new Date(a.time));

    const result = { data: notifications.slice(0, 15), unreadMessages };
    cache.set(cacheKey, result, 120); // 2 minutes
    res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
};
