'use strict';

/**
 * One-off inspection: list every company's name, slug, storeSlug and store state.
 *
 *   node scripts/checkStoreSlugs.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Company = require('../src/models/Company');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, family: 4 });

  const companies = await Company.find({})
    .select('companyName slug storeSlug storeEnabled paymentSettings.isPaymentSetup createdAt')
    .sort({ createdAt: 1 })
    .lean();

  if (!companies.length) {
    console.log('No companies found.');
  } else {
    for (const c of companies) {
      console.log('─'.repeat(60));
      console.log('companyName :', c.companyName);
      console.log('slug        :', c.slug);
      console.log('storeSlug   :', c.storeSlug ?? '(not set)');
      console.log('storeEnabled:', c.storeEnabled === true);
      console.log('paymentSetup:', c.paymentSettings?.isPaymentSetup === true);
      console.log('would-be    :', Company.slugify(c.companyName));
      console.log('_id         :', String(c._id));
    }
    console.log('─'.repeat(60));
    console.log(`${companies.length} company/companies total`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
