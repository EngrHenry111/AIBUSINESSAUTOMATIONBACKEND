'use strict';

/**
 * Universal file fetcher.
 * - Local path → fs.readFileSync
 * - Cloudinary authenticated → uses cloudinary.utils.private_download_url (signed)
 * - Public URL → plain HTTPS fetch
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const logger = require('./logger');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading file`));
      }
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out after 60s')); });
  });
}

async function downloadFile(filePathOrUrl, publicId) {
  // ── Local disk ────────────────────────────────────────────────────────────
  if (filePathOrUrl && !filePathOrUrl.startsWith('http')) {
    if (!fs.existsSync(filePathOrUrl)) throw new Error(`File not found: ${filePathOrUrl}`);
    return fs.readFileSync(filePathOrUrl);
  }

  // ── Cloudinary: generate a proper private download URL using the SDK ───────
  if (publicId && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
    try {
      const cloudinary = require('cloudinary').v2;

      // private_download_url generates a short-lived signed download URL
      // that bypasses access control — works for both 'upload' and 'authenticated' types
      const signedUrl = cloudinary.utils.private_download_url(
        publicId,
        '', // format — empty string keeps original
        {
          resource_type: 'raw',
          expires_at: Math.floor(Date.now() / 1000) + 600, // 10 min
          attachment: false,
        }
      );

      logger.info(`Fetching via private_download_url: ${publicId}`);
      return await fetchUrl(signedUrl);
    } catch (err) {
      logger.warn(`Cloudinary private URL failed: ${err.message} — trying plain URL`);
    }
  }

  // ── Plain public URL fallback ─────────────────────────────────────────────
  logger.info(`Fetching plain URL: ${filePathOrUrl}`);
  return fetchUrl(filePathOrUrl);
}

module.exports = { downloadFile };