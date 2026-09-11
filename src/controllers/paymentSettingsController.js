'use strict';

const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');
const { writeAuditLog } = require('../utils/auditLog');
const { paystackAPI } = require('../utils/paystack');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const PLATFORM_COMMISSION = Number(process.env.STOREFRONT_COMMISSION_PERCENT) || 3;
const mask = (acct) => (acct && acct.length >= 4 ? `****${acct.slice(-4)}` : acct || null);

// ── GET /payment-settings ─────────────────────────────────────────────
exports.getPaymentSettings = async (req, res, next) => {
  try {
    const company = await Company.findById(req.companyId).select('companyName paymentSettings');
    if (!company) return next(new AppError('Company not found.', 404));

    const ps = company.paymentSettings || {};
    res.status(200).json({
      success: true,
      data: {
        isPaymentSetup: Boolean(ps.isPaymentSetup),
        bankName: ps.bankName || null,
        bankCode: ps.bankCode || null,
        accountName: ps.accountName || null,
        accountNumberMasked: mask(ps.accountNumber),
        subaccountCode: ps.paystackSubaccountCode || null,
        commissionPercent: ps.commissionPercent ?? PLATFORM_COMMISSION,
        settlementSchedule: ps.settlementSchedule || 'auto',
      },
    });
  } catch (err) { next(err); }
};

// ── GET /payment-settings/banks ──────────────────────────────────────
exports.getBanks = async (req, res, next) => {
  try {
    const cached = cache.get('paystack_banks_ngn');
    if (cached) return res.status(200).json({ success: true, data: cached, cached: true });

    const r = await paystackAPI('GET', '/bank?currency=NGN&perPage=100');
    const banks = (r.data || [])
      .map((b) => ({ name: b.name, code: b.code, slug: b.slug }))
      .sort((a, b) => a.name.localeCompare(b.name));

    cache.set('paystack_banks_ngn', banks, 86400); // 24h
    res.status(200).json({ success: true, data: banks });
  } catch (err) { next(err); }
};

// ── POST /payment-settings/verify-account ────────────────────────────
exports.verifyAccount = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!/^\d{10}$/.test(String(accountNumber || ''))) {
      return next(new AppError('Enter a valid 10-digit account number.', 400));
    }
    if (!bankCode) return next(new AppError('Select a bank.', 400));

    const r = await paystackAPI('GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
    res.status(200).json({
      success: true,
      data: {
        accountName: r.data?.account_name,
        accountNumber: r.data?.account_number,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /payment-settings/setup ────────────────────────────────────
exports.createSubaccount = async (req, res, next) => {
  try {
    const { bankCode, accountNumber, businessName } = req.body;
    if (!bankCode || !/^\d{10}$/.test(String(accountNumber || ''))) {
      return next(new AppError('Bank and a valid 10-digit account number are required.', 400));
    }

    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));

    // Resolve the account name (also confirms the details are valid)
    const resolved = await paystackAPI('GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
    const accountName = resolved.data?.account_name;
    if (!accountName) return next(new AppError('Could not verify that account. Check the details and try again.', 400));

    const bizName = (businessName || company.companyName || '').trim();
    let bankName = null;
    try {
      const banks = cache.get('paystack_banks_ngn')
        || (await paystackAPI('GET', '/bank?currency=NGN&perPage=100')).data;
      bankName = (banks || []).find((b) => b.code === bankCode)?.name || null;
    } catch { /* non-fatal */ }

    let result;
    if (company.paymentSettings?.paystackSubaccountCode) {
      // Already has a subaccount — update it instead of creating a duplicate
      result = await paystackAPI('PUT', `/subaccount/${company.paymentSettings.paystackSubaccountCode}`, {
        settlement_bank: bankCode,
        account_number: accountNumber,
      });
    } else {
      result = await paystackAPI('POST', '/subaccount', {
        business_name: bizName,
        settlement_bank: bankCode,
        account_number: accountNumber,
        percentage_charge: PLATFORM_COMMISSION,
        description: `BizlyAI - ${bizName}`,
      });
    }

    const sub = result.data || {};
    if (!company.paymentSettings) company.paymentSettings = {};
    company.paymentSettings.paystackSubaccountCode = sub.subaccount_code || company.paymentSettings.paystackSubaccountCode;
    company.paymentSettings.paystackSubaccountId = sub.id ? String(sub.id) : company.paymentSettings.paystackSubaccountId;
    company.paymentSettings.bankName = bankName || company.paymentSettings.bankName;
    company.paymentSettings.bankCode = bankCode;
    company.paymentSettings.accountNumber = accountNumber;
    company.paymentSettings.accountName = accountName;
    company.paymentSettings.isPaymentSetup = true;
    company.paymentSettings.commissionPercent = PLATFORM_COMMISSION;
    company.paymentSettings.settlementSchedule = sub.settlement_schedule || 'auto';

    // Payments are ready — put the store live automatically so the client
    // never has to remember to flip a second switch. Make sure it has a
    // slug to be reachable at (backfill, never reassign an existing one).
    if (!company.storeSlug) {
      company.storeSlug = await Company.generateStoreSlug(company.companyName, company._id);
    }
    company.storeEnabled = true;

    await company.save();

    await writeAuditLog({
      companyId: req.companyId, userId: req.user._id, action: 'payment.subaccount_setup',
      description: `${accountName} · ${bankName || bankCode}`, ip: req.ip,
    });
    logger.info(`Subaccount ready for company ${req.companyId}: ${company.paymentSettings.paystackSubaccountCode} — store auto-enabled`);

    res.status(200).json({
      success: true,
      data: {
        accountName,
        bankName,
        accountNumberMasked: mask(accountNumber),
        subaccountCode: company.paymentSettings.paystackSubaccountCode,
        storeEnabled: company.storeEnabled,
        storeSlug: company.storeSlug,
      },
    });
  } catch (err) { next(err); }
};

// ── PUT /payment-settings/update ────────────────────────────────────
exports.updateSubaccount = async (req, res, next) => {
  try {
    const { bankCode, accountNumber, businessName } = req.body;
    const company = await Company.findById(req.companyId);
    if (!company) return next(new AppError('Company not found.', 404));
    if (!company.paymentSettings?.paystackSubaccountCode) {
      return next(new AppError('No subaccount to update — set up payments first.', 400));
    }
    if (accountNumber && !/^\d{10}$/.test(String(accountNumber))) {
      return next(new AppError('Enter a valid 10-digit account number.', 400));
    }

    const payload = {};
    if (bankCode) payload.settlement_bank = bankCode;
    if (accountNumber) payload.account_number = accountNumber;
    if (businessName) payload.business_name = businessName;

    let accountName = company.paymentSettings.accountName;
    if (bankCode && accountNumber) {
      const resolved = await paystackAPI('GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
      accountName = resolved.data?.account_name || accountName;
    }

    await paystackAPI('PUT', `/subaccount/${company.paymentSettings.paystackSubaccountCode}`, payload);

    if (bankCode) {
      company.paymentSettings.bankCode = bankCode;
      try {
        const banks = cache.get('paystack_banks_ngn');
        if (banks) company.paymentSettings.bankName = banks.find((b) => b.code === bankCode)?.name || company.paymentSettings.bankName;
      } catch { /* ignore */ }
    }
    if (accountNumber) company.paymentSettings.accountNumber = accountNumber;
    company.paymentSettings.accountName = accountName;
    await company.save();

    await writeAuditLog({ companyId: req.companyId, userId: req.user._id, action: 'payment.subaccount_update', ip: req.ip });
    res.status(200).json({
      success: true,
      data: {
        accountName,
        bankName: company.paymentSettings.bankName,
        accountNumberMasked: mask(company.paymentSettings.accountNumber),
      },
    });
  } catch (err) { next(err); }
};
