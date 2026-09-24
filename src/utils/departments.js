'use strict';

// Standard departments every company gets for free — not stored per-company,
// just merged in at read time (see companyController.getDepartments) so
// existing companies get them with no migration. Company.departments only
// ever holds a company's own CUSTOM additions on top of this list.
const DEFAULT_DEPARTMENTS = [
  'Finance', 'Sales', 'Marketing', 'Admin', 'Auditors',
  'Operations', 'HR', 'IT', 'Customer Support', 'Legal',
];

module.exports = { DEFAULT_DEPARTMENTS };
