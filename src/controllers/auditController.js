'use strict';

const AuditLog = require('../models/AuditLog');

// Category → action-prefix regex, for the frontend's action-type dropdown
const CATEGORY_PATTERNS = {
  auth: '^user\\.(login|logout|register|2fa|email|password)',
  document: '^document\\.',
  lead: '^lead\\.',
  invoice: '^invoice\\.',
  order: '^order\\.',
  appointment: '^appointment\\.',
  team: '^user\\.(invite|remove|role)',
  settings: '^(company\\.|user\\.profile|user\\.settings|settings\\.)',
  billing: '^(subscription\\.|payment\\.|billing\\.)',
  whatsapp: '^whatsapp\\.',
};

function buildFilter(req) {
  const filter = { companyId: req.companyId };
  const { userId, action, startDate, endDate, search } = req.query;

  if (userId) filter.userId = userId;

  if (action) {
    filter.action = CATEGORY_PATTERNS[action]
      ? { $regex: CATEGORY_PATTERNS[action] }
      : action;
  }

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) filter.timestamp.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.timestamp.$lte = end;
    }
  }

  if (search && search.trim()) {
    const rx = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filter.$or = [{ description: rx }, { action: rx }];
  }

  return filter;
}

function shape(log) {
  return {
    _id: log._id,
    action: log.action,
    resource: log.resource || null,
    description: log.description || '',
    status: log.status || 'success',
    ip: log.ip || null,
    user: log.userId ? { _id: log.userId._id, name: log.userId.name, avatar: log.userId.avatar || null } : null,
    timestamp: log.timestamp,
  };
}

// ── GET /audit-logs ─────────────────────────────────────────────────────
exports.getAuditLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = buildFilter(req);

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('userId', 'name avatar')
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      logs: logs.map(shape),
      total,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) { next(err); }
};

// ── GET /audit-logs/export ─────────────────────────────────────────────
exports.exportAuditLogs = async (req, res, next) => {
  try {
    const filter = buildFilter(req);
    const logs = await AuditLog.find(filter)
      .populate('userId', 'name')
      .sort({ timestamp: -1 })
      .limit(10000)
      .lean();

    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const maskIp = (ip) => {
      if (!ip) return '';
      const p = String(ip).split('.');
      return p.length === 4 ? `xxx.xxx.x.${p[3]}` : ip;
    };

    const rows = logs.map((l) => {
      const d = new Date(l.timestamp);
      return [
        esc(d.toLocaleDateString('en-CA')),
        esc(d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })),
        esc(l.userId?.name || 'System'),
        esc(l.action),
        esc(l.description || ''),
        esc(maskIp(l.ip)),
      ].join(',');
    });

    const csv = ['Date,Time,User,Action,Description,IP', ...rows].join('\n');
    const filename = `bizlyai-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
};
