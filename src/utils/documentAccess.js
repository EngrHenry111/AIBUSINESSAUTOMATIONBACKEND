'use strict';

// Documents marked managersOnly (salaries, contracts, board papers…) are
// hidden from employees everywhere: the Knowledge list, document view,
// search, knowledge bases and the AI Assistant's answers.
const Document = require('../models/Document');

const MANAGER_ROLES = ['super_admin', 'company_owner', 'manager'];
const seesManagersOnly = (user) => MANAGER_ROLES.includes(user?.role);

// Extra Document query conditions for this user.
const documentFilterFor = (user) => (seesManagersOnly(user) ? {} : { managersOnly: { $ne: true } });

// Document ids whose chunks this user's AI Assistant must not read.
async function hiddenDocumentIds(companyId, user) {
  if (seesManagersOnly(user)) return [];
  return Document.find({ companyId, managersOnly: true }).distinct('_id');
}

module.exports = { seesManagersOnly, documentFilterFor, hiddenDocumentIds };
