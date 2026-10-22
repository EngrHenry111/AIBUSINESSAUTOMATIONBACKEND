'use strict';

// Split a report's sales and short/over between the people who handled it.
//
// Forecourt sheets: each nozzle carries its own attendant and takings. An
// expense marked "paid by" someone is credited to that person (it came out
// of their cash); unattributed expenses and credit sales are shared out in
// proportion to each person's sales, so the parts always add back up to the
// report's own variance.
function attendantBreakdown(r) {
  const totals = r.totals || {};
  const lines = (r.pumps || []).filter((p) => p.attendant);
  if (!lines.length) {
    return r.attendantName
      ? [{ name: r.attendantName, sales: totals.expectedSales || 0, variance: totals.variance || 0, gap: totals.meterGapLitres || 0, nozzles: [] }]
      : [];
  }
  const lineTotal = lines.reduce((s, p) => s + (p.amount || 0), 0) || 1;
  const perNozzle = lines.some((p) => p.cash || p.pos || p.transfer);
  const names = new Set(lines.map((p) => p.attendant));
  const direct = {};
  // Credit given from a specific nozzle is that attendant's (they collected no
  // cash for it); credit not tied to a nozzle is shared like other items.
  const nozzleOwner = new Map(lines.map((p) => [p.nozzle, p.attendant]));
  const itemised = r.creditSales || [];
  let shared = itemised.length ? 0 : (r.collections?.credit || 0);
  itemised.forEach((x) => {
    const who = x.nozzle && nozzleOwner.get(x.nozzle);
    if (who) direct[who] = (direct[who] || 0) + (x.amount || 0);
    else shared += x.amount || 0;
  });
  (r.expenses || []).forEach((e) => {
    if (e.paidBy && names.has(e.paidBy)) direct[e.paidBy] = (direct[e.paidBy] || 0) + (e.amount || 0);
    else shared += e.amount || 0;
  });

  const by = {};
  lines.forEach((p) => {
    const share = (p.amount || 0) / lineTotal;
    const v = perNozzle ? (p.variance || 0) + shared * share : (totals.variance || 0) * share;
    by[p.attendant] = by[p.attendant] || { name: p.attendant, sales: 0, variance: 0, gap: 0, nozzles: [] };
    const a = by[p.attendant];
    a.sales += p.amount || 0;
    a.variance += v;
    a.gap += Math.abs(p.meterGap || 0);
    if (p.nozzle && !a.nozzles.includes(p.nozzle)) a.nozzles.push(p.nozzle);
  });
  if (perNozzle) Object.entries(direct).forEach(([name, amt]) => { by[name].variance += amt; });
  return Object.values(by).map((a) => ({ ...a, variance: Math.round(a.variance * 100) / 100 }));
}

module.exports = { attendantBreakdown };
