'use strict';

// Allowlist-based field selection for PUT/PATCH handlers. Using this instead
// of Object.assign(doc, req.body) is a hard requirement for any endpoint that
// updates a tenant-scoped document — Object.assign lets a client overwrite
// ANY schema field, including companyId itself (silently moving a document
// into a different tenant, or an invalid one), plus internal bookkeeping
// fields (stockApplied, pointsAwarded, paystackReference, createdBy, ...)
// that must never be client-writable. See the CWE-915 fixes across
// orderController/productController/expenseController/meetingController.
function pick(source, allowedKeys) {
  const out = {};
  if (!source) return out;
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

module.exports = { pick };
