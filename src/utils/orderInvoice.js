'use strict';

const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Company = require('../models/Company');
const { currencyFieldsFor } = require('../services/currencyService');
const { createWithNumber } = require('./invoiceNumbers');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function invoiceStatusFor(order) {
  if (order.paymentStatus === 'paid') return 'paid';
  if (order.paymentStatus === 'partial') return 'partial';
  return 'draft';
}

function addressOf(order) {
  const c = order.customer || {};
  const s = order.shippingAddress || {};
  return [c.address || s.street, c.city || s.city, c.state, s.country].filter(Boolean).join(', ') || undefined;
}

// Builds (once) the invoice for an order. Idempotent: a second call, or a
// concurrent one losing the unique-orderId race, returns the existing
// invoice instead of creating a duplicate. Deliberately does NOT call
// recordCustomerTransaction — the order already recorded this sale.
async function createInvoiceFromOrder(order, { userId, dueInDays = 7 } = {}) {
  if (order.invoiceId) {
    const existing = await Invoice.findOne({ _id: order.invoiceId, companyId: order.companyId });
    if (existing) return { invoice: existing, created: false };
  }
  const byOrder = await Invoice.findOne({ companyId: order.companyId, orderId: order._id });
  if (byOrder) {
    await Order.updateOne({ _id: order._id }, { invoiceId: byOrder._id, invoiceNumber: byOrder.invoiceNumber });
    return { invoice: byOrder, created: false };
  }

  const items = (order.items || []).map((i) => {
    const quantity = Number(i.quantity) || 1;
    const unitPrice = round2(i.price);
    return {
      description: [i.name, i.variant && `(${i.variant})`, i.sku && `— SKU ${i.sku}`].filter(Boolean).join(' '),
      quantity, unitPrice, total: round2(quantity * unitPrice),
    };
  });
  if (order.deliveryFee > 0) {
    items.push({ description: 'Delivery', quantity: 1, unitPrice: round2(order.deliveryFee), total: round2(order.deliveryFee) });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const total = round2(order.total ?? subtotal);
  // Coupon + loyalty + gift card all reduce what the customer owes; express
  // them as one discount so subtotal − discount = total always holds.
  const discount = round2(Math.max(0, subtotal - total));

  let currency = order.currency;
  if (!currency) {
    const company = await Company.findById(order.companyId).select('defaultCurrency').lean();
    currency = company?.defaultCurrency || 'NGN';
  }
  const { exchangeRate, ngnEquivalent } = await currencyFieldsFor(currency, total);

  const status = invoiceStatusFor(order);
  const now = new Date();
  const paymentNote = {
    paystack: 'Paid online via Paystack.',
    pay_on_delivery: 'Payment due on delivery.',
    split_payment: 'Split payment — balance due on delivery.',
  }[order.paymentMethod];

  let invoice;
  try {
    invoice = await createWithNumber({
      companyId: order.companyId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      customer: {
        name: order.customer?.name || 'Customer',
        email: order.customer?.email,
        phone: order.customer?.phone,
        address: addressOf(order),
      },
      items,
      subtotal,
      tax: 0,
      discount,
      total,
      currency,
      exchangeRate,
      ngnEquivalent,
      status,
      issuedAt: now,
      dueAt: new Date(now.getTime() + dueInDays * DAY_MS),
      paidAt: status === 'paid' ? now : undefined,
      notes: [`Order ${order.orderNumber}.`, paymentNote, order.couponCode && `Coupon: ${order.couponCode}.`].filter(Boolean).join(' '),
      createdBy: userId || order.createdBy,
    });
  } catch (err) {
    if (err.code === 11000 && /orderId/.test(err.message)) {
      const existing = await Invoice.findOne({ companyId: order.companyId, orderId: order._id });
      if (existing) return { invoice: existing, created: false };
    }
    throw err;
  }

  await Order.updateOne(
    { _id: order._id },
    {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      $push: { timeline: { status: 'invoiced', description: `Invoice ${invoice.invoiceNumber} generated`, timestamp: now } },
    },
  );
  order.invoiceId = invoice._id;
  order.invoiceNumber = invoice.invoiceNumber;
  return { invoice, created: true };
}

// Order → invoice. Called from Order's post-save hook. Uses updateOne so it
// never re-enters any save hook.
async function syncInvoiceFromOrder(order) {
  if (!order.invoiceId) return;
  const invoice = await Invoice.findOne({ _id: order.invoiceId, companyId: order.companyId }).select('status');
  if (!invoice) return;

  let update = null;
  if (['cancelled', 'refunded'].includes(order.status) || order.paymentStatus === 'refunded') {
    if (invoice.status !== 'cancelled') update = { status: 'cancelled' };
  } else if (order.paymentStatus === 'paid' && invoice.status !== 'paid') {
    update = { status: 'paid', paidAt: new Date() };
  } else if (order.paymentStatus === 'partial' && ['draft', 'sent', 'viewed', 'overdue'].includes(invoice.status)) {
    update = { status: 'partial' };
  }
  if (update) {
    await Invoice.updateOne({ _id: invoice._id }, update);
    require('./cache').del(`dashboard_${order.companyId}`);
  }
}

// Invoice → order: an invoice marked paid marks its order paid.
async function syncOrderFromInvoice(invoice) {
  if (!invoice.orderId || invoice.status !== 'paid') return;
  await Order.updateOne(
    { _id: invoice.orderId, companyId: invoice.companyId, paymentStatus: { $ne: 'paid' } },
    {
      paymentStatus: 'paid',
      $push: { timeline: { status: 'paid', description: `Payment recorded on invoice ${invoice.invoiceNumber}`, timestamp: new Date() } },
    },
  );
}

// Storefront hook — fire-and-forget after an order is placed.
async function autoInvoiceStoreOrder(company, order) {
  if (company?.storeSettings?.autoInvoiceOrders === false) return;
  try {
    await createInvoiceFromOrder(order);
  } catch (err) {
    logger.warn(`Auto-invoice failed for order ${order.orderNumber}: ${err.message}`);
  }
}

module.exports = { createInvoiceFromOrder, syncInvoiceFromOrder, syncOrderFromInvoice, autoInvoiceStoreOrder };
