'use strict';

const Invoice = require('../models/Invoice');

// Next INV-<year>-<seq> for a company. Derived from the highest existing
// number for the year — NOT countDocuments()+1, which re-issues an existing
// number as soon as any invoice is deleted and then fails the unique
// (companyId, invoiceNumber) index.
async function nextInvoiceNumber(companyId, year = new Date().getFullYear()) {
  const prefix = `INV-${year}-`;
  const rows = await Invoice.find({ companyId, invoiceNumber: { $regex: `^${prefix}\\d+$` } })
    .select('invoiceNumber').lean();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.invoiceNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

// Invoice.create with a freshly allocated number, retrying if a concurrent
// request grabbed the same one first.
async function createWithNumber(doc, attempts = 5) {
  for (let i = 0; ; i++) {
    const invoiceNumber = await nextInvoiceNumber(doc.companyId);
    try {
      return await Invoice.create({ ...doc, invoiceNumber });
    } catch (err) {
      const numberClash = err.code === 11000 && /invoiceNumber/.test(err.message);
      if (!numberClash || i >= attempts - 1) throw err;
    }
  }
}

module.exports = { nextInvoiceNumber, createWithNumber };
