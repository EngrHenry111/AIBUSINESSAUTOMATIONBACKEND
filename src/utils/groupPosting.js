'use strict';

// Side effects of a branch report leaving draft:
//  • items picked from stock come off that branch's stock balance
//  • credit sales are posted to each credit customer's account
// Both are undone if the report is sent back, and re-applied on resubmit,
// so stock and debtor balances always match the live (non-rejected) reports.
const GroupStockItem = require('../models/GroupStockItem');
const GroupStockMove = require('../models/GroupStockMove');
const GroupCreditCustomer = require('../models/GroupCreditCustomer');
const GroupCreditTxn = require('../models/GroupCreditTxn');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const addDaysDate = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

async function moveStock(item, { type, qty, unitCost, by, reportId, reference, note, date, extra = {} }) {
  const updated = await GroupStockItem.findOneAndUpdate({ _id: item._id }, { $inc: { quantity: qty } }, { new: true });
  await GroupStockMove.create({
    companyId: item.companyId, branchId: item.branchId, itemId: item._id, itemName: item.name,
    type, qty, balanceAfter: updated.quantity, unitCost, value: round2(qty * unitCost),
    reportId: reportId || null, reference, note, byName: by, date: date || new Date(), ...extra,
  });
  return updated;
}

async function postReportEffects(report, byName) {
  if (!report.stockPosted) {
    for (const line of report.items) {
      if (!line.itemId || !line.quantity) continue;
      // eslint-disable-next-line no-await-in-loop
      const item = await GroupStockItem.findOne({ _id: line.itemId, branchId: report.branchId });
      if (!item) continue;
      // eslint-disable-next-line no-await-in-loop
      await moveStock(item, {
        type: 'sale', qty: -line.quantity, unitCost: line.unitCost || item.costPrice || 0, by: byName,
        reportId: report._id, reference: report.referenceNumber,
        note: `Sales report for ${new Date(report.reportDate).toISOString().slice(0, 10)}`,
      });
    }
    report.stockPosted = true;
  }

  if (!report.creditPosted) {
    for (const sale of report.creditSales) {
      if (!sale.amount) continue;
      // eslint-disable-next-line no-await-in-loop
      const customer = await GroupCreditCustomer.findOne({ _id: sale.customerId, companyId: report.companyId });
      if (!customer) continue;
      // eslint-disable-next-line no-await-in-loop
      await GroupCreditTxn.create({
        companyId: report.companyId, customerId: customer._id, branchId: report.branchId, branchName: report.branchName,
        type: 'sale', amount: sale.amount, date: report.reportDate, dueDate: addDaysDate(report.reportDate, customer.termsDays || 0),
        reference: sale.reference || report.referenceNumber, vehicle: sale.vehicle, reportId: report._id,
        note: [report.department, sale.nozzle].filter(Boolean).join(' · '), byName,
      });
      // eslint-disable-next-line no-await-in-loop
      await GroupCreditCustomer.updateOne({ _id: customer._id }, { $inc: { balance: sale.amount } });
    }
    report.creditPosted = true;
  }
}

async function reverseReportEffects(report, byName) {
  if (report.stockPosted) {
    const moves = await GroupStockMove.find({ reportId: report._id, type: 'sale' });
    for (const m of moves) {
      // eslint-disable-next-line no-await-in-loop
      const item = await GroupStockItem.findById(m.itemId);
      if (!item) continue;
      // eslint-disable-next-line no-await-in-loop
      await moveStock(item, {
        type: 'sale_reversal', qty: -m.qty, unitCost: m.unitCost, by: byName, reportId: report._id,
        reference: report.referenceNumber, note: 'Report sent back, stock returned',
      });
    }
    report.stockPosted = false;
  }

  if (report.creditPosted) {
    // The sale never became final, so it comes off the account entirely.
    const txns = await GroupCreditTxn.find({ reportId: report._id, type: 'sale' });
    for (const t of txns) {
      // eslint-disable-next-line no-await-in-loop
      await GroupCreditCustomer.updateOne({ _id: t.customerId }, { $inc: { balance: -t.amount } });
    }
    await GroupCreditTxn.deleteMany({ reportId: report._id, type: 'sale' });
    report.creditPosted = false;
  }
}

module.exports = { postReportEffects, reverseReportEffects, moveStock };
