'use strict';

// Private uploads (expense receipts, meeting attachments, procurement
// quotations, knowledge files) are stored on Cloudinary as "authenticated"
// assets: their stored URL opens nothing on its own. The app hands out a
// signed link that works for a few minutes, only to a signed-in member of
// the company whose folder the file sits in (see routes/fileRoutes).
const { cloudinary } = require('../config/cloudinary');

// https://res.cloudinary.com/<cloud>/<resource_type>/authenticated/v<version>/<public_id>[.<ext>]
const PRIVATE_URL_RE = /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|raw|video)\/authenticated\/(?:v\d+\/)?([^?#]+)$/;

async function uploadPrivate(localPath, { folder, resourceType = 'auto', ...options }) {
  const r = await cloudinary.uploader.upload(localPath, { folder, resource_type: resourceType, type: 'authenticated', ...options });
  return { url: r.secure_url, publicId: r.public_id };
}

function parsePrivateUrl(url) {
  const m = PRIVATE_URL_RE.exec(String(url || ''));
  if (!m) return null;
  const resourceType = m[1];
  let publicId = decodeURIComponent(m[2]);
  let format = '';
  // Raw files keep their extension in the public id; images/videos don't.
  if (resourceType !== 'raw') {
    const dot = publicId.lastIndexOf('.');
    if (dot > publicId.lastIndexOf('/')) { format = publicId.slice(dot + 1); publicId = publicId.slice(0, dot); }
  }
  return { resourceType, publicId, format };
}

function signedLink(url, seconds = 300) {
  const p = parsePrivateUrl(url);
  if (!p || !cloudinary) return null;
  return cloudinary.utils.private_download_url(p.publicId, p.format, {
    resource_type: p.resourceType,
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + seconds,
    attachment: false,
  });
}

module.exports = { uploadPrivate, parsePrivateUrl, signedLink, PRIVATE_URL_RE };
