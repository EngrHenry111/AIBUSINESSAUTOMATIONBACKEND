'use strict';

const { AppError } = require('./errorMiddleware');

const ROLE_HIERARCHY = {
  super_admin: 5,
  company_owner: 4,
  manager: 3,
  employee: 2,
  customer: 1,
};

// Require specific roles
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new AppError('Authentication required.', 401));
  if (!roles.includes(req.user.role)) {
    return next(new AppError(`Access denied. Required role: ${roles.join(' or ')}.`, 403));
  }
  next();
};

// Require minimum role level
const requireMinRole = (minRole) => (req, res, next) => {
  if (!req.user) return next(new AppError('Authentication required.', 401));
  const userLevel = ROLE_HIERARCHY[req.user.role] || 0;
  const minLevel = ROLE_HIERARCHY[minRole] || 0;
  if (userLevel < minLevel) {
    return next(new AppError('Insufficient permissions for this action.', 403));
  }
  next();
};

const isSuperAdmin = requireRole('super_admin');
const isCompanyOwner = requireMinRole('company_owner');
const isManager = requireMinRole('manager');
const isEmployee = requireMinRole('employee');

module.exports = { requireRole, requireMinRole, isSuperAdmin, isCompanyOwner, isManager, isEmployee };
