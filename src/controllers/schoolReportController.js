'use strict';

// Term-end report for the proprietor: what was billed, discounted, waived,
// collected and is still owed — and, over the term's dates, the cash that
// came in against the term's expenses and payroll.

const mongoose = require('mongoose');
const FeeBill = require('../models/FeeBill');
const FeePayment = require('../models/FeePayment');
const Student = require('../models/Student');
const AdmissionApplication = require('../models/AdmissionApplication');
const Expense = require('../models/Expense');
const Payroll = require('../models/Payroll');
const { TERMS, round2, oid, getSettings } = require('../utils/school');

const TZ = process.env.SCHOOL_TZ || 'Africa/Lagos';

exports.getTermReport = async (req, res, next) => {
  try {
    const settings = await getSettings(req.companyId);
    const session = String(req.query.session || settings.currentSession);
    const term = TERMS.includes(req.query.term) ? req.query.term : settings.currentTerm;
    const cid = oid(req.companyId);
    const termBills = { companyId: cid, session, term, status: { $ne: 'cancelled' } };

    // Term window for cash flow: explicit from/to, else the current term's
    // dates from settings (only meaningful for the current term).
    const isCurrent = session === settings.currentSession && term === settings.currentTerm;
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : (isCurrent ? settings.termStart : null);
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999`) : (isCurrent ? settings.termEnd : null);
    const windowEnd = to && to < new Date() ? to : new Date();
    const hasWindow = Boolean(from);

    const [billTotals, byStatus, byClass, byItem, termPaymentsByMethod, termPaymentsByMonth, debtors] = await Promise.all([
      FeeBill.aggregate([
        { $match: termBills },
        { $group: {
          _id: null,
          gross: { $sum: '$subtotal' },
          discounts: { $sum: { $cond: [{ $ne: ['$status', 'waived'] }, '$discount', 0] } },
          waived: { $sum: { $cond: [{ $eq: ['$status', 'waived'] }, { $subtract: ['$subtotal', '$amountPaid'] }, 0] } },
          collected: { $sum: '$amountPaid' },
          outstanding: { $sum: { $cond: [{ $in: ['$status', ['unpaid', 'partial']] }, { $max: ['$balance', 0] }, 0] } },
          credit: { $sum: { $cond: [{ $lt: ['$balance', 0] }, { $multiply: ['$balance', -1] }, 0] } },
          bills: { $sum: 1 },
          students: { $addToSet: '$studentId' },
        } },
      ]),
      FeeBill.aggregate([{ $match: termBills }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$total' } } }]),
      FeeBill.aggregate([
        { $match: { ...termBills, status: { $nin: ['cancelled', 'waived'] } } },
        { $group: { _id: '$classId', billed: { $sum: '$total' }, collected: { $sum: '$amountPaid' }, outstanding: { $sum: { $max: ['$balance', 0] } }, students: { $addToSet: '$studentId' }, paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } } } },
        { $lookup: { from: 'schoolclasses', localField: '_id', foreignField: '_id', as: 'c' } },
        { $project: { billed: 1, collected: 1, outstanding: 1, paid: 1, students: { $size: '$students' }, name: { $first: '$c.name' }, level: { $first: '$c.level' } } },
        { $sort: { level: 1, name: 1 } },
      ]),
      FeeBill.aggregate([
        { $match: { ...termBills, status: { $nin: ['cancelled'] } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.name', billed: { $sum: '$items.amount' }, bills: { $sum: 1 } } },
        { $sort: { billed: -1 } },
      ]),
      FeePayment.aggregate([
        { $match: { companyId: cid, voided: false } },
        { $lookup: { from: 'feebills', localField: 'billId', foreignField: '_id', as: 'b', pipeline: [{ $project: { session: 1, term: 1 } }] } },
        { $match: { 'b.session': session, 'b.term': term } },
        { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } },
      ]),
      FeePayment.aggregate([
        { $match: { companyId: cid, voided: false } },
        { $lookup: { from: 'feebills', localField: 'billId', foreignField: '_id', as: 'b', pipeline: [{ $project: { session: 1, term: 1 } }] } },
        { $match: { 'b.session': session, 'b.term': term } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: TZ } }, amount: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]),
      FeeBill.aggregate([
        { $match: { companyId: cid, session, term, status: { $in: ['unpaid', 'partial'] }, balance: { $gt: 0 } } },
        { $group: { _id: '$studentId', balance: { $sum: '$balance' } } },
        { $sort: { balance: -1 } }, { $limit: 10 },
        { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 's' } },
        { $unwind: '$s' },
        { $lookup: { from: 'schoolclasses', localField: 's.classId', foreignField: '_id', as: 'c' } },
        { $project: { balance: 1, name: { $concat: ['$s.lastName', ' ', '$s.firstName'] }, admissionNumber: '$s.admissionNumber', phone: '$s.guardian.phone', className: { $first: '$c.name' } } },
      ]),
    ]);

    const t = billTotals[0] || { gross: 0, discounts: 0, waived: 0, collected: 0, outstanding: 0, credit: 0, bills: 0, students: [] };
    const netBilled = round2(t.gross - t.discounts - t.waived);
    const fees = {
      gross: round2(t.gross), discounts: round2(t.discounts), waived: round2(t.waived), netBilled,
      collected: round2(t.collected), outstanding: round2(t.outstanding), credit: round2(t.credit),
      collectionRate: netBilled > 0 ? Math.round((t.collected / netBilled) * 1000) / 10 : null,
      bills: t.bills, students: t.students.length,
      byStatus: Object.fromEntries(byStatus.map((s) => [s._id, { count: s.count, amount: round2(s.amount) }])),
      byClass, byItem, byMethod: termPaymentsByMethod, byMonth: termPaymentsByMonth, topDebtors: debtors,
    };

    // ── Cash flow over the term's dates ──────────────────────────────────
    let cashflow = null;
    if (hasWindow) {
      const range = { $gte: from, $lte: windowEnd };
      const months = [];
      for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= windowEnd; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
      }
      const [cashIn, expenses, payrolls] = await Promise.all([
        FeePayment.aggregate([
          { $match: { companyId: cid, voided: false, paidAt: range } },
          { $lookup: { from: 'feebills', localField: 'billId', foreignField: '_id', as: 'b', pipeline: [{ $project: { session: 1, term: 1 } }] } },
          { $group: {
            _id: { $and: [{ $eq: [{ $first: '$b.session' }, session] }, { $eq: [{ $first: '$b.term' }, term] }] },
            amount: { $sum: '$amount' }, count: { $sum: 1 },
          } },
        ]),
        Expense.aggregate([
          { $match: { companyId: cid, date: range, status: { $ne: 'rejected' } } },
          { $group: { _id: { category: '$category', ngn: { $eq: [{ $ifNull: ['$currency', 'NGN'] }, 'NGN'] } }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
        ]),
        months.length ? Payroll.find({ companyId: cid, $or: months }).select('year month status totalNet totalGross').lean() : [],
      ]);
      const thisTerm = cashIn.find((c) => c._id === true)?.amount || 0;
      const arrears = cashIn.find((c) => c._id === false)?.amount || 0;
      const expNgn = expenses.filter((e) => e._id.ngn);
      const expenseTotal = round2(expNgn.reduce((s, e) => s + e.amount, 0));
      const payrollTotal = round2(payrolls.reduce((s, p) => s + (p.totalNet || 0), 0));
      const totalIn = round2(thisTerm + arrears);
      cashflow = {
        from, to: windowEnd,
        feesThisTerm: round2(thisTerm), arrearsRecovered: round2(arrears), totalIn,
        expenses: expenseTotal,
        expensesByCategory: expNgn.map((e) => ({ category: e._id.category, amount: round2(e.amount), count: e.count })).sort((a, b) => b.amount - a.amount),
        otherCurrencyExpenses: expenses.filter((e) => !e._id.ngn).reduce((s, e) => s + e.count, 0),
        payroll: payrollTotal,
        payrollRuns: payrolls.map((p) => ({ year: p.year, month: p.month, status: p.status, net: round2(p.totalNet || 0) })),
        net: round2(totalIn - expenseTotal - payrollTotal),
      };
    }

    // ── Enrolment ────────────────────────────────────────────────────────
    const enrolmentRange = hasWindow ? { $gte: from, $lte: windowEnd } : null;
    const [active, joined, left, applications] = await Promise.all([
      Student.countDocuments({ companyId: cid, status: 'active' }),
      enrolmentRange ? Student.countDocuments({ companyId: cid, admittedAt: enrolmentRange }) : null,
      enrolmentRange ? Student.aggregate([{ $match: { companyId: cid, leftAt: enrolmentRange } }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : [],
      enrolmentRange ? AdmissionApplication.aggregate([{ $match: { companyId: cid, createdAt: enrolmentRange } }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : [],
    ]);

    res.status(200).json({
      success: true,
      data: {
        school: { schoolName: settings.schoolName, motto: settings.motto, address: settings.address, logo: settings.logo },
        session, term, generatedAt: new Date(), hasWindow,
        fees, cashflow,
        enrolment: {
          active, joined,
          left: Object.fromEntries(left.map((l) => [l._id, l.count])),
          applications: Object.fromEntries(applications.map((a) => [a._id, a.count])),
        },
      },
    });
  } catch (err) { next(err); }
};
