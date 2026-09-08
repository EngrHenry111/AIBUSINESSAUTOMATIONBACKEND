'use strict';

const Customer = require('../models/Customer');
const logger = require('./logger');

/**
 * Upsert a customer record from an order or invoice and roll up their totals.
 * Never throws — a sync failure must not break the parent transaction.
 *
 * @param {Object}   opts
 * @param {ObjectId} opts.companyId
 * @param {Object}   opts.customer        { name, email, phone, address }
 * @param {Number}   [opts.amount=0]      value to add to totalSpent
 * @param {Boolean}  [opts.countsAsOrder] increment totalOrders
 * @param {Date}     [opts.date]          lastOrderAt (defaults to now)
 * @param {ObjectId} [opts.userId]        createdBy for a new record
 */
async function recordCustomerTransaction({
  companyId, customer, amount = 0, countsAsOrder = true, date, userId,
}) {
  try {
    if (!customer) return null;
    const email = (customer.email || '').trim().toLowerCase();
    const phone = (customer.phone || '').trim();
    const name = (customer.name || '').trim();
    if (!email && !phone) return null; // need something to match on

    const match = { companyId };
    match.$or = [];
    if (email) match.$or.push({ email });
    if (phone) match.$or.push({ phone });

    const when = date ? new Date(date) : new Date();
    const existing = await Customer.findOne(match);

    if (existing) {
      existing.totalSpent += Number(amount) || 0;
      if (countsAsOrder) existing.totalOrders += 1;
      if (!existing.lastOrderAt || when > existing.lastOrderAt) existing.lastOrderAt = when;
      if (!existing.email && email) existing.email = email;
      if (!existing.phone && phone) existing.phone = phone;
      if (existing.status === 'inactive') existing.status = 'active';
      await existing.save();
      return existing;
    }

    return await Customer.create({
      companyId,
      name: name || email || phone,
      email: email || undefined,
      phone: phone || undefined,
      address: customer.address,
      totalSpent: Number(amount) || 0,
      totalOrders: countsAsOrder ? 1 : 0,
      lastOrderAt: when,
      createdBy: userId,
    });
  } catch (err) {
    logger.warn(`Customer sync failed: ${err.message}`);
    return null;
  }
}

module.exports = { recordCustomerTransaction };
