'use strict';

// The customer's pay page: /pay/:token. No login — the token in the link is
// the key, and it only ever reaches the person the invoice was sent to.

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { paystackAPI } = require('../utils/paystack');
const { balanceOf, canPayOnline, payUrlFor, fulfilInvoicePayment } = require('../utils/invoicePayments');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;

async function findByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new AppError('This payment link is not valid.', 404);
  const invoice = await Invoice.findOne({ payToken: token });
  if (!invoice || invoice.status === 'draft') throw new AppError('This payment link is not valid.', 404);
  const company = await Company.findById(invoice.companyId).select('companyName logo website profile paymentSettings');
  if (!company) throw new AppError('This payment link is not valid.', 404);
  return { invoice, company };
}

function publicView(invoice, company) {
  const ps = company.paymentSettings || {};
  return {
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    customerName: invoice.customer?.name,
    issuedAt: invoice.issuedAt || invoice.createdAt,
    dueAt: invoice.dueAt,
    currency: invoice.currency || 'NGN',
    items: (invoice.items || []).map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, total: i.total })),
    subtotal: invoice.subtotal, tax: invoice.tax, discount: invoice.discount, total: invoice.total,
    amountPaid: invoice.amountPaid || 0,
    balance: balanceOf(invoice),
    notes: invoice.notes || null,
    canPayOnline: canPayOnline(company, invoice),
    business: {
      name: company.companyName,
      logo: company.logo || null,
      email: company.profile?.email || null,
      phone: company.profile?.phone || null,
      address: company.profile?.address || null,
      bank: ps.isPaymentSetup ? { bankName: ps.bankName, accountName: ps.accountName, accountNumber: ps.accountNumber } : null,
    },
  };
}

// GET /pay/:token
exports.getInvoice = async (req, res, next) => {
  try {
    const { invoice, company } = await findByToken(req.params.token);
    if (invoice.status === 'sent') await Invoice.updateOne({ _id: invoice._id, status: 'sent' }, { status: 'viewed' });
    res.status(200).json({ success: true, data: publicView(invoice, company) });
  } catch (err) { next(err); }
};

// POST /pay/:token/start { email? } — always the full outstanding balance.
exports.startPayment = async (req, res, next) => {
  try {
    const { invoice, company } = await findByToken(req.params.token);
    const balance = balanceOf(invoice);
    if (balance <= 0) throw new AppError('This invoice has nothing left to pay.', 400);
    if (!canPayOnline(company, invoice)) throw new AppError('This business does not take online payments for this invoice. Use the bank details shown.', 400);

    const email = String(req.body.email || invoice.customer?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter an email address for your receipt.', 400);

    const back = payUrlFor(req.params.token);
    const initRes = await paystackAPI('POST', '/transaction/initialize', {
      email,
      amount: Math.round(balance * 100),
      currency: 'NGN',
      subaccount: company.paymentSettings.paystackSubaccountCode,
      bearer: 'subaccount',
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      metadata: {
        type: 'invoice_payment',
        companyId: String(company._id),
        invoiceId: String(invoice._id),
        invoiceNumber: invoice.invoiceNumber,
        amount: balance,
        cancel_action: `${back}?payment=cancelled`,
      },
      callback_url: back,
    });
    if (!initRes.status) throw new AppError('Could not start the payment. Please try again.', 502);
    res.status(200).json({ success: true, data: { authorizationUrl: initRes.data.authorization_url, reference: initRes.data.reference } });
  } catch (err) { next(err); }
};

// GET /pay/:token/verify/:reference — the customer's return from Paystack.
exports.verifyPayment = async (req, res, next) => {
  try {
    const { invoice, company } = await findByToken(req.params.token);
    const { reference } = req.params;
    if (invoice.payments?.some((p) => p.reference === reference)) {
      return res.status(200).json({ success: true, data: { state: 'paid', invoice: publicView(invoice, company) } });
    }
    const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    const txn = vr.data || {};
    if (String(txn.metadata?.invoiceId) !== String(invoice._id)) throw new AppError('Payment not found for this invoice.', 404);
    if (['pending', 'ongoing', 'processing', 'queued'].includes(txn.status)) {
      return res.status(202).json({ success: true, data: { state: 'pending' } });
    }
    if (txn.status !== 'success') {
      return res.status(200).json({ success: true, data: { state: 'failed', message: txn.gateway_response || 'The payment was not completed.' } });
    }
    const { invoice: updated } = await fulfilInvoicePayment(txn);
    res.status(200).json({ success: true, data: { state: 'paid', invoice: publicView(updated, company) } });
  } catch (err) { next(err); }
};
