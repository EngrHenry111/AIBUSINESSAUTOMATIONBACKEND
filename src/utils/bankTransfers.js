'use strict';

// Dedicated bank accounts and automatic matching of transfers.
//
// Each student can have their own account number (a Paystack dedicated
// virtual account that settles into the school's subaccount). When a parent
// transfers into it, Paystack sends charge.success with channel
// "dedicated_nuban"; we confirm the transaction with Paystack, record it once
// (unique reference), and apply the money to the student's outstanding
// bills oldest-first. Anything left over is held as credit.

const mongoose = require('mongoose');
const VirtualAccount = require('../models/VirtualAccount');
const BankTransfer = require('../models/BankTransfer');
const FeeBill = require('../models/FeeBill');
const FeePayment = require('../models/FeePayment');
const Student = require('../models/Student');
const Company = require('../models/Company');
const { paystackAPI } = require('./paystack');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('./logger');
const { round2, getSettings, nextNumber, applyToBill, emitSchool } = require('./school');

const fee = () => require('../controllers/schoolFeeController')._internal;

// ── Creating accounts ────────────────────────────────────────────────────
async function getStudentAccount(companyId, studentId) {
  return VirtualAccount.findOne({ companyId, ownerType: 'student', ownerId: studentId }).lean();
}

/**
 * Gives a student their own account number (idempotent — returns the
 * existing one). Each student gets their own Paystack customer, keyed by a
 * unique address, so siblings sharing a parent's email still get separate
 * accounts and every transfer maps to exactly one child.
 */
async function createStudentAccount(companyId, studentId) {
  const existing = await getStudentAccount(companyId, studentId);
  if (existing) return existing;

  const [student, company, settings] = await Promise.all([
    Student.findOne({ _id: studentId, companyId }).lean(),
    Company.findById(companyId).select('paymentSettings').lean(),
    getSettings(companyId),
  ]);
  if (!student) throw new AppError('Student not found.', 404);
  const subaccount = company?.paymentSettings?.isPaymentSetup && company.paymentSettings.paystackSubaccountCode;
  if (!subaccount) throw new AppError("Connect the school's bank account (Store settings → Payments) before creating transfer accounts.", 400);

  const phone = String(student.guardian?.phone || '').replace(/\D/g, '');
  const customer = await paystackAPI('POST', '/customer', {
    email: `student-${student._id}@pay.bislyai.com`,
    first_name: student.firstName,
    last_name: student.lastName,
    ...(phone.length >= 10 && { phone: `+234${phone.slice(-10)}` }),
    metadata: { companyId: String(companyId), studentId: String(student._id), admissionNumber: student.admissionNumber },
  });
  const customerCode = customer?.data?.customer_code;
  if (!customerCode) throw new AppError('Paystack did not return a customer.', 502);

  const dva = await paystackAPI('POST', '/dedicated_account', {
    customer: customerCode,
    preferred_bank: settings.bankAccounts?.preferredBank || 'wema-bank',
    subaccount,
  });
  const d = dva?.data;
  if (!d?.account_number) throw new AppError('Paystack did not return an account number.', 502);

  try {
    return (await VirtualAccount.create({
      companyId, ownerType: 'student', ownerId: student._id,
      paystackCustomerCode: customerCode, paystackDvaId: d.id,
      accountNumber: d.account_number, accountName: d.account_name,
      bankName: d.bank?.name, bankSlug: d.bank?.slug, active: d.active !== false,
    })).toObject();
  } catch (err) {
    if (err.code === 11000) return getStudentAccount(companyId, studentId); // created concurrently
    throw err;
  }
}

// Background bulk creation with progress over the socket. Paystack is
// called one student at a time, gently, to stay inside its rate limits.
async function createAccountsForStudents(companyId, studentIds, io) {
  const total = studentIds.length;
  let done = 0; let failed = 0; let lastError = null;
  for (const id of studentIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await createStudentAccount(companyId, id);
      done += 1;
    } catch (err) {
      failed += 1; lastError = err.message;
      logger.error(`Dedicated account for student ${id} failed: ${err.message}`);
      // A setup problem (no subaccount, feature not enabled on Paystack)
      // fails for everyone — stop instead of hammering the API.
      if (err.statusCode === 400 && failed >= 3 && done === 0) break;
    }
    if ((done + failed) % 5 === 0 || done + failed === total) {
      emitSchool(io, companyId, 'bank-accounts', { done, failed, total, lastError });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 350));
  }
  emitSchool(io, companyId, 'bank-accounts', { done, failed, total, lastError, finished: true });
  return { done, failed, total, lastError };
}

// ── Applying money ───────────────────────────────────────────────────────
/**
 * Spends a transfer's remaining credit on the student's outstanding bills,
 * oldest first. Each slice is reserved on the transfer first (atomic
 * $inc guarded by creditRemaining >= amount) and only then applied to the
 * bill (guarded by balance) — so neither side can be over-spent by a
 * concurrent payment, webhook retry or staff click. Returns the receipts.
 */
async function applyTransferCredit(transferId, { by = 'auto', io } = {}) {
  const payments = [];
  for (let guard = 0; guard < 50; guard += 1) {
    // eslint-disable-next-line no-await-in-loop
    const t = await BankTransfer.findById(transferId).lean();
    if (!t || t.creditRemaining <= 0.001 || t.ownerType !== 'student') break;
    // eslint-disable-next-line no-await-in-loop
    const bill = await FeeBill.findOne({ companyId: t.companyId, studentId: t.ownerId, status: { $in: ['unpaid', 'partial'] }, balance: { $gt: 0 } })
      .sort({ dueDate: 1, createdAt: 1 }).lean();
    if (!bill) break;
    const take = round2(Math.min(t.creditRemaining, bill.balance));

    // eslint-disable-next-line no-await-in-loop
    const reserved = await BankTransfer.updateOne({ _id: t._id, creditRemaining: { $gte: take - 0.001 } }, { $inc: { creditRemaining: -take } });
    if (!reserved.modifiedCount) continue; // someone else spent it — re-read
    // eslint-disable-next-line no-await-in-loop
    const updated = await applyToBill(t.companyId, bill._id, take, { guard: true });
    if (!updated) { // bill changed under us (desk payment) — give the money back and retry
      // eslint-disable-next-line no-await-in-loop
      await BankTransfer.updateOne({ _id: t._id }, { $inc: { creditRemaining: take } });
      continue;
    }
    let payment;
    try {
      // eslint-disable-next-line no-await-in-loop
      payment = await FeePayment.create({
        companyId: t.companyId,
        // eslint-disable-next-line no-await-in-loop
        receiptNumber: await nextNumber(t.companyId, 'receipt'),
        billId: bill._id, studentId: t.ownerId, amount: take, method: 'bank_transfer',
        reference: t.reference, transferId: t._id,
        payerName: t.senderName,
        note: by === 'auto' ? `Bank transfer to the student's account — matched automatically${t.senderBank ? ` (from ${t.senderBank})` : ''}` : 'Transfer credit applied by staff',
        paidAt: by === 'auto' ? t.paidAt : new Date(),
      });
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await applyToBill(t.companyId, bill._id, -take);
      // eslint-disable-next-line no-await-in-loop
      await BankTransfer.updateOne({ _id: t._id }, { $inc: { creditRemaining: take } });
      throw err;
    }
    // eslint-disable-next-line no-await-in-loop
    await BankTransfer.updateOne({ _id: t._id }, { $push: { allocations: { kind: 'fee_bill', billId: bill._id, billNumber: bill.billNumber, paymentId: payment._id, amount: take, by } } });
    payments.push({ payment, bill: updated });
  }

  const final = await BankTransfer.findById(transferId);
  if (final) {
    const applied = final.amount - final.creditRemaining;
    final.status = final.creditRemaining <= 0.001 ? 'applied' : applied > 0.001 ? 'partially_applied' : 'credit';
    await final.save();
    if (payments.length) {
      const student = await Student.findById(final.ownerId).lean();
      const { announcePayment, emailReceipt } = fee();
      for (const { payment, bill } of payments) {
        announcePayment({ app: { get: () => io } }, final.companyId, payment, student, bill, { transfer: true });
        emailReceipt(final.companyId, payment, student, bill).catch(() => {});
      }
    }
    emitSchool(io, final.companyId, 'transfers', { transferId: final._id, studentId: final.ownerId });
  }
  return { transfer: final, payments: payments.map((p) => p.payment) };
}

/**
 * Webhook entry point for charge.success on a dedicated account. Confirms
 * the transaction with Paystack (never trusts the webhook body alone),
 * records it once, then applies it.
 */
async function handleDedicatedTransfer(webhookData, { io } = {}) {
  const reference = webhookData?.reference;
  if (!reference) return null;
  const seen = await BankTransfer.findOne({ reference }).lean();
  if (seen) return seen;

  const vr = await paystackAPI('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  const txn = vr?.data || {};
  if (txn.status !== 'success' || (txn.currency && txn.currency !== 'NGN')) {
    logger.error(`Dedicated transfer ${reference} not confirmed: status=${txn.status} currency=${txn.currency}`);
    return null;
  }
  const auth = txn.authorization || webhookData.authorization || {};
  const customerCode = txn.customer?.customer_code || webhookData.customer?.customer_code;
  const accountNumber = auth.receiver_bank_account_number || txn.metadata?.receiver_account_number;
  const va = await VirtualAccount.findOne(customerCode ? { paystackCustomerCode: customerCode } : { accountNumber }).lean()
    || (accountNumber ? await VirtualAccount.findOne({ accountNumber }).lean() : null);
  if (!va) {
    logger.error(`Dedicated transfer ${reference}: no account on file for customer ${customerCode} / ${accountNumber}`);
    return null;
  }

  const amount = round2(Number(txn.amount) / 100);
  let transfer;
  try {
    transfer = await BankTransfer.create({
      companyId: va.companyId, reference, amount, currency: txn.currency || 'NGN',
      paidAt: txn.paid_at ? new Date(txn.paid_at) : new Date(),
      senderName: auth.sender_name || null,
      senderBank: auth.sender_bank || null,
      senderAccount: auth.sender_bank_account_number || null,
      narration: auth.narration || null,
      virtualAccountId: va._id, accountNumber: va.accountNumber,
      ownerType: va.ownerType, ownerId: va.ownerId,
      creditRemaining: amount,
    });
  } catch (err) {
    if (err.code === 11000) return BankTransfer.findOne({ reference }).lean(); // webhook retry raced us
    throw err;
  }
  io?.to(`company:${va.companyId}`).emit('notification:refresh', { type: 'bank_transfer' });
  const { transfer: done } = await applyTransferCredit(transfer._id, { io });
  return done;
}

// New bills for students who hold transfer credit get paid from it.
async function applyStudentCredits(companyId, studentIds, io) {
  const transfers = await BankTransfer.find({
    companyId, ownerType: 'student', creditRemaining: { $gt: 0.001 },
    ...(studentIds && { ownerId: { $in: studentIds } }),
  }).sort({ paidAt: 1 }).select('_id').lean();
  let applied = 0;
  for (const t of transfers) {
    // eslint-disable-next-line no-await-in-loop
    const { payments } = await applyTransferCredit(t._id, { io });
    applied += payments.length;
  }
  return applied;
}

module.exports = {
  applyStudentCredits, getStudentAccount, createStudentAccount, createAccountsForStudents,
  applyTransferCredit, handleDedicatedTransfer,
};
