'use strict';

// Enterprise plan pricing for multi-branch groups:
//   base price covers the first N branches, each branch beyond that adds a
//   fixed monthly amount; annual billing = monthly × annualMonths (2 free).
// Amounts are whole naira. Override on the server with env vars if needed.
const ENTERPRISE_PRICING = {
  base: Number(process.env.ENTERPRISE_BASE_PRICE) || 99900,
  includedBranches: Number(process.env.ENTERPRISE_INCLUDED_BRANCHES) || 3,
  perBranch: Number(process.env.ENTERPRISE_PER_BRANCH_PRICE) || 25000,
  annualMonths: Number(process.env.ENTERPRISE_ANNUAL_MONTHS) || 10,
};

function enterpriseQuote(branchCount) {
  const p = ENTERPRISE_PRICING;
  const branches = Math.max(1, Number(branchCount) || 0);
  const extraBranches = Math.max(0, branches - p.includedBranches);
  const monthly = p.base + extraBranches * p.perBranch;
  return {
    ...p,
    branches,
    extraBranches,
    monthly,
    annual: monthly * p.annualMonths,
    annualSavings: monthly * (12 - p.annualMonths),
  };
}

module.exports = { ENTERPRISE_PRICING, enterpriseQuote };
