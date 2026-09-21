'use strict';

const QRCode = require('qrcode');
const User = require('../models/User');
const Company = require('../models/Company');
const { AppError } = require('../middleware/errorMiddleware');

const CLIENT_URL = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const USERNAME_RE = /^[a-z0-9.]{3,30}$/;
const ROLE_LABELS = { super_admin: 'Administrator', company_owner: 'Business Owner', manager: 'Manager', employee: 'Team Member', customer: 'Customer' };
const roleLabel = (role) => ROLE_LABELS[role] || role;

function findByUsername(username) {
  return User.findOne({ 'cardSettings.username': String(username || '').toLowerCase().trim() });
}

// vCard 3.0 requires backslash-escaping , ; \ and newlines within a value,
// and CRLF line endings — iOS Contacts in particular is strict about both.
const vcardEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');

function buildVCard(user, company) {
  const cs = user.cardSettings || {};
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardEscape(user.name)}`];
  if (company?.companyName) lines.push(`ORG:${vcardEscape(company.companyName)}`);
  lines.push(`TITLE:${vcardEscape(roleLabel(user.role))}`);
  if (cs.showPhone !== false && user.phone) lines.push(`TEL;TYPE=CELL:${vcardEscape(user.phone)}`);
  if (cs.showEmail !== false && user.email) lines.push(`EMAIL:${vcardEscape(user.email)}`);
  const website = (cs.links || []).find((l) => l.type === 'website' && l.url);
  if (website) lines.push(`URL:${vcardEscape(website.url)}`);
  if (cs.bio) lines.push(`NOTE:${vcardEscape(cs.bio)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

// Explicit public allowlist — never leak _id, companyId, view/save counts
// (owner-only stats), or contact fields the owner has hidden.
function publicCard(user, company) {
  const cs = user.cardSettings || {};
  return {
    name: user.name,
    company: company?.companyName || null,
    role: roleLabel(user.role),
    tagline: cs.tagline || null,
    bio: cs.bio || null,
    avatar: user.avatar || null,
    email: cs.showEmail !== false ? user.email : null,
    phone: cs.showPhone !== false ? user.phone : null,
    links: (cs.links || []).map((l) => ({ type: l.type, label: l.label, url: l.url, icon: l.icon })),
    primaryColor: cs.primaryColor || '#6366f1',
    template: cs.template || 'modern',
  };
}

// ── GET /card/:username ─────────────────────────────────────────────────
exports.getCard = async (req, res, next) => {
  try {
    const user = await findByUsername(req.params.username);
    if (!user || user.cardSettings?.enabled === false) {
      return next(new AppError('Card not found.', 404));
    }
    const company = user.companyId ? await Company.findById(user.companyId).select('companyName') : null;

    User.updateOne({ _id: user._id }, { $inc: { 'cardSettings.views': 1 } }).catch(() => {});

    res.status(200).json({ success: true, data: publicCard(user, company) });
  } catch (err) { next(err); }
};

// ── POST /card/:username/save ───────────────────────────────────────────
exports.saveContact = async (req, res, next) => {
  try {
    const user = await findByUsername(req.params.username);
    if (!user || user.cardSettings?.enabled === false) {
      return next(new AppError('Card not found.', 404));
    }
    const company = user.companyId ? await Company.findById(user.companyId).select('companyName') : null;

    await User.updateOne({ _id: user._id }, { $inc: { 'cardSettings.saves': 1 } });

    res.status(200).json({ success: true, vcard: buildVCard(user, company) });
  } catch (err) { next(err); }
};

// ── GET /card/:username/vcard ────────────────────────────────────────────
// A direct GET (not a fetch-and-blob) is what actually triggers "Add to
// Contacts" reliably on iOS Safari and Android Chrome — so this is meant to
// be a plain <a href> / window.location navigation, not an XHR call.
exports.generateVCard = async (req, res, next) => {
  try {
    const user = await findByUsername(req.params.username);
    if (!user || user.cardSettings?.enabled === false) {
      return next(new AppError('Card not found.', 404));
    }
    const company = user.companyId ? await Company.findById(user.companyId).select('companyName') : null;
    const vcard = buildVCard(user, company);
    const filename = (user.name || 'contact').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'contact';

    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.vcf"`);
    res.send(vcard);
  } catch (err) { next(err); }
};

// ── GET /card/:username/qrcode ───────────────────────────────────────────
// qrcode is already a backend dependency (used for WhatsApp linking); no
// frontend QR library is installed, so the QR is rendered here as a PNG and
// the editor just points an <img>/download link straight at this URL.
exports.getCardQRCode = async (req, res, next) => {
  try {
    const user = await findByUsername(req.params.username);
    if (!user || user.cardSettings?.enabled === false) {
      return next(new AppError('Card not found.', 404));
    }
    const url = `${CLIENT_URL()}/card/${user.cardSettings.username}`;
    const buffer = await QRCode.toBuffer(url, { width: 512, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (err) { next(err); }
};

// ── GET /card/me/settings ────────────────────────────────────────────────
exports.getMyCard = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('name email phone avatar role cardSettings');
    if (!user) return next(new AppError('User not found.', 404));

    const cs = user.cardSettings || {};
    res.status(200).json({
      success: true,
      data: {
        profile: { name: user.name, email: user.email, phone: user.phone, avatar: user.avatar, role: roleLabel(user.role) },
        cardSettings: cs,
        url: cs.username ? `${CLIENT_URL()}/card/${cs.username}` : null,
        stats: {
          views: cs.views || 0,
          saves: cs.saves || 0,
          shareRate: cs.views ? Math.round(((cs.saves || 0) / cs.views) * 1000) / 10 : 0,
        },
      },
    });
  } catch (err) { next(err); }
};

// ── PATCH /card/me/settings ──────────────────────────────────────────────
exports.updateMyCard = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found.', 404));
    if (!user.cardSettings) user.cardSettings = {};

    const { username, tagline, bio, primaryColor, template, links, showEmail, showPhone, enabled } = req.body;

    if (username !== undefined && username !== user.cardSettings.username) {
      const clean = String(username).toLowerCase().trim();
      if (!USERNAME_RE.test(clean)) {
        return next(new AppError('Username must be 3-30 characters: lowercase letters, numbers and dots only.', 400));
      }
      const clash = await User.exists({ 'cardSettings.username': clean, _id: { $ne: user._id } });
      if (clash) return next(new AppError('That username is already taken.', 409));
      user.cardSettings.username = clean;
    }

    if (tagline !== undefined) user.cardSettings.tagline = tagline;
    if (bio !== undefined) user.cardSettings.bio = bio;
    if (primaryColor !== undefined) user.cardSettings.primaryColor = primaryColor;
    if (template !== undefined) user.cardSettings.template = template;
    if (showEmail !== undefined) user.cardSettings.showEmail = Boolean(showEmail);
    if (showPhone !== undefined) user.cardSettings.showPhone = Boolean(showPhone);
    if (enabled !== undefined) user.cardSettings.enabled = Boolean(enabled);
    if (Array.isArray(links)) {
      user.cardSettings.links = links
        .filter((l) => l && l.url)
        .slice(0, 20)
        .map((l) => ({ type: l.type || 'custom', label: l.label || '', url: l.url, icon: l.icon || '' }));
    }

    await user.save();
    res.status(200).json({ success: true, data: user.cardSettings });
  } catch (err) {
    if (err.code === 11000) return next(new AppError('That username is already taken.', 409));
    next(err);
  }
};
