'use strict';

/**
 * One-off: move private files uploaded before authenticated storage
 * (expense receipts, meeting attachments, procurement quotations, knowledge
 * files) from public Cloudinary delivery to authenticated, and save the new
 * URLs. Logos, banners, product images and avatars stay public.
 *
 *   node scripts/privatizeFiles.js           # dry run: lists what would change
 *   node scripts/privatizeFiles.js --apply   # does it
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { cloudinary } = require('../src/config/cloudinary');
const Expense = require('../src/models/Expense');
const Meeting = require('../src/models/Meeting');
const Procurement = require('../src/models/Procurement');
const Document = require('../src/models/Document');

const APPLY = process.argv.includes('--apply');
const PUBLIC_RE = /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|raw|video)\/upload\/(?:v\d+\/)?([^?#]+)$/;
const PRIVATE_FOLDER_RE = /^business-ai\/[0-9a-f]{24}\/(receipts|meetings|procurement|documents)\//;
const counts = { found: 0, moved: 0, failed: 0 };

// Returns the new URL, or null when the file isn't one to move.
async function privatize(url) {
  const m = PUBLIC_RE.exec(String(url || ''));
  if (!m) return null;
  const resourceType = m[1];
  let publicId = decodeURIComponent(m[2]);
  if (resourceType !== 'raw') {
    const dot = publicId.lastIndexOf('.');
    if (dot > publicId.lastIndexOf('/')) publicId = publicId.slice(0, dot);
  }
  if (!PRIVATE_FOLDER_RE.test(publicId)) return null;
  counts.found += 1;
  if (!APPLY) { console.log(`would move  ${publicId}`); return null; }
  try {
    const r = await cloudinary.uploader.rename(publicId, publicId, { resource_type: resourceType, type: 'upload', to_type: 'authenticated' });
    counts.moved += 1;
    console.log(`moved       ${publicId}`);
    return r.secure_url;
  } catch (err) {
    counts.failed += 1;
    console.log(`FAILED      ${publicId}: ${err.message || err.error?.message}`);
    return null;
  }
}

async function main() {
  if (!cloudinary) throw new Error('Cloudinary is not configured (CLOUDINARY_* env vars).');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, family: 4 });

  for (const e of await Expense.find({ receipt: /res\.cloudinary\.com\/.+\/upload\// }).select('receipt')) {
    const url = await privatize(e.receipt);
    if (url) await Expense.updateOne({ _id: e._id }, { receipt: url });
  }
  for (const mtg of await Meeting.find({ 'attachments.url': /res\.cloudinary\.com\/.+\/upload\// }).select('attachments')) {
    let changed = false;
    for (const a of mtg.attachments) {
      const url = await privatize(a.url);
      if (url) { a.url = url; changed = true; }
    }
    if (changed) await mtg.save();
  }
  for (const p of await Procurement.find({ 'vendors.quotationDocument': /res\.cloudinary\.com\/.+\/upload\// }).select('vendors')) {
    let changed = false;
    for (const v of p.vendors) {
      const url = await privatize(v.quotationDocument);
      if (url) { v.quotationDocument = url; changed = true; }
    }
    if (changed) await p.save({ validateBeforeSave: false });
  }
  for (const d of await Document.find({ cloudinaryUrl: /res\.cloudinary\.com\/.+\/upload\// }).select('cloudinaryUrl')) {
    const url = await privatize(d.cloudinaryUrl);
    if (url) await Document.updateOne({ _id: d._id }, { cloudinaryUrl: url });
  }

  console.log(APPLY
    ? `\nDone: ${counts.moved} moved, ${counts.failed} failed (of ${counts.found}).`
    : `\nDry run: ${counts.found} file(s) would move. Run again with --apply to do it.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
