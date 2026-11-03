'use strict';

// Money in against an invoice: balances, the customer's pay link, and the
// one place a payment is applied (by hand, or from Paystack via the webhook
// or the customer's return to the pay page).

const crypto = require('crypto');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const { AppError } = require('../middleware/errorMiddleware');
const { formatCurrency } = require('../services/currencyService');
const logger = require('./logger');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');

// A paid or cancelled invoice owes nothing, including ones from before
// amountPaid existed.
function balanceOf(invoice) {
  if (!invoice || ['paid', 'cancelled'].includes(invoice.status)) return 0;
  return Math.max(0, round2((invoice.total || 0) - (invoice.amountPaid || 0)));
}

const moneyOf = (amount, currency) => formatCurrency(amount, currency || 'NGN');

// Paystack settles straight into the business's own subaccount, in naira.
function canPayOnline(company, invoice) {
  const ps = company?.paymentSettings;
  return Boolean(ps?.isPaymentSetup && ps.paystackSubaccountCode && (invoice.currency || 'NGN') === 'NGN' && balanceOf(invoice) > 0);
}

async function ensurePayToken(invoice) {
  if (invoice.payToken) return invoice.payToken;
  const token = crypto.randomBytes(18).toString('base64url');
  // Only set it if nobody else did in the meantime.
  const updated = await Invoice.findOneAndUpdate(
    { _id: invoice._id, payToken: { $exists: false } }, { $set: { payToken: token } }, { new: true },
  ).select('payToken').lean();
  invoice.payToken = updated?.payToken || (await Invoice.findById(invoice._id).select('payToken').lean())?.payToken;
  return invoice.payToken;
}

const payUrlFor = (token) => `${clientUrl()}/pay/${token}`;
async function payLink(invoice) { return payUrlFor(await ensurePayToken(invoice)); }

// Things that happen once, when an invoice becomes fully paid.
function onFullyPaid(invoice) {
  const { syncOrderFromInvoice } = require('./orderInvoice');
  syncOrderFromInvoice(invoice).catch(() => {});
  require('../controllers/invoiceController').awardLoyaltyForInvoice(invoice, invoice.companyId).catch(() => {});
  require('./cache').del(`dashboard_${invoice.companyId}`);
}

/**
 * Adds a payment and moves the status to partial/paid. With a reference it
 * is idempotent: the same reference is never counted twice.
 */
async function applyInvoicePayment(invoiceId, companyId, { amount, method, reference, note, paidAt, userId }) {
  const value = round2(amount);
  if (!(value > 0)) throw new AppError('Enter an amount greater than zero.', 400);
  const filter = { _id: invoiceId, companyId };
  if (reference) filter['payments.reference'] = { $ne: reference };

  const invoice = await Invoice.findOneAndUpdate(filter, {
    $push: { payments: { amount: value, method, reference, note, paidAt: paidAt || new Date(), recordedBy: userId } },
    $inc: { amountPaid: value },
  }, { new: true });
  if (!invoice) {
    if (reference) {
      const existing = await Invoice.findOne({ _id: invoiceId, companyId, 'payments.reference': reference });
      if (existing) return { invoice: existing, duplicate: true };
    }
    throw new AppError('Invoice not found.', 404);
  }

  const wasPaid = invoice.status === 'paid';
  const fullyPaid = round2(invoice.amountPaid) >= round2(invoice.total);
  invoice.status = fullyPaid ? 'paid' : (invoice.status === 'cancelled' ? 'cancelled' : 'partial');
  if (fullyPaid && !invoice.paidAt) invoice.paidAt = paidAt || new Date();
  await invoice.save();
  if (fullyPaid && !wasPaid) onFullyPaid(invoice);
  return { invoice, duplicate: false };
}

/**
 * Credits a successful Paystack invoice payment. Used by the webhook and by
 * the pay page's verify call; whichever arrives first records it.
 */
async function fulfilInvoicePayment(txn) {
  const meta = txn.metadata || {};
  const expectedKobo = Math.round(Number(meta.amount) * 100);
  const problems = [];
  if (meta.type !== 'invoice_payment') problems.push(`type=${meta.type}`);
  if (txn.status !== 'success') problems.push(`status=${txn.status}`);
  if (txn.currency && txn.currency !== 'NGN') problems.push(`currency=${txn.currency}`);
  if (!(expectedKobo > 0) || !(Number(txn.amount) >= expectedKobo)) problems.push(`amount=${txn.amount} expected>=${expectedKobo}`);
  if (!mongoose.isValidObjectId(meta.invoiceId) || !mongoose.isValidObjectId(meta.companyId)) problems.push('bad metadata');
  if (problems.length) {
    logger.error(`Refusing invoice payment ${txn.reference}: ${problems.join(', ')}`);
    throw new AppError('Payment could not be confirmed with Paystack.', 400);
  }
  // Money was collected, so it is always recorded, even past the balance.
  return applyInvoicePayment(meta.invoiceId, meta.companyId, {
    amount: Number(txn.amount) / 100,
    method: 'paystack',
    reference: txn.reference,
    note: `Paid online via Paystack (${txn.channel || 'online'})`,
    paidAt: txn.paid_at ? new Date(txn.paid_at) : new Date(),
  });
}

module.exports = {
  round2, balanceOf, moneyOf, canPayOnline, ensurePayToken, payLink, payUrlFor,
  applyInvoicePayment, fulfilInvoicePayment,
};
