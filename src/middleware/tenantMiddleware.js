'use strict';

const Company = require('../models/Company');
const { AppError } = require('./errorMiddleware');

const enforceTenant = async (req, res, next) => {
  try {
    if (!req.user) return next(new AppError('Authentication required.', 401));

    // Super admins can bypass tenant isolation with explicit companyId param
    if (req.user.role === 'super_admin' && req.headers['x-company-id']) {
      req.companyId = req.headers['x-company-id'];
      return next();
    }

    if (!req.user.companyId) {
      return next(new AppError('User is not associated with any company.', 403));
    }

    // Validate company is active
    const company = await Company.findById(req.user.companyId).select('status subscription');
    if (!company) {
      return next(new AppError('Company not found.', 404));
    }
    if (company.status !== 'active') {
      return next(new AppError('Company account is suspended. Please contact support.', 403));
    }

    req.companyId = req.user.companyId;
    req.company = company;
    next();
  } catch (err) {
    next(err);
  }
};

// Inject companyId into query automatically
const injectTenant = (req, res, next) => {
  if (req.user?.companyId) {
    req.companyId = req.user.companyId;
  }
  next();
};

module.exports = { enforceTenant, injectTenant };
