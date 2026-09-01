'use strict';

const AuditLog = require('../models/AuditLog');
const logger = require('./logger');

const writeAuditLog = async ({
  companyId, userId, action, resource, resourceId,
  description, metadata, ip, userAgent, status = 'success',
}) => {
  try {
    await AuditLog.create({
      companyId, userId, action, resource, resourceId,
      description, metadata, ip, userAgent, status,
    });
  } catch (err) {
    // Never fail the request due to audit log write failure
    logger.error('Failed to write audit log:', err);
  }
};

// Middleware version
const auditMiddleware = (action, resource, getResourceId = null) =>
  async (req, res, next) => {
    const originalSend = res.json.bind(res);
    res.json = (body) => {
      const status = body?.success === false ? 'failure' : 'success';
      writeAuditLog({
        companyId: req.companyId,
        userId: req.user?.id,
        action,
        resource,
        resourceId: getResourceId ? getResourceId(req, body) : req.params?.id,
        description: `${req.method} ${req.originalUrl}`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        status,
      });
      return originalSend(body);
    };
    next();
  };

module.exports = { writeAuditLog, auditMiddleware };
