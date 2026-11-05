'use strict';

// Starting price lists for new laundry and cleaning businesses. Typical
// Lagos prices (2026) — every business edits them on its price-list page.

const LAUNDRY_SERVICES = ['Wash & Iron', 'Dry Clean', 'Iron Only', 'Starch & Iron'];

const p = (washIron, dryClean, ironOnly, starch) => {
  const out = {};
  if (washIron != null) out['Wash & Iron'] = washIron;
  if (dryClean != null) out['Dry Clean'] = dryClean;
  if (ironOnly != null) out['Iron Only'] = ironOnly;
  if (starch != null) out['Starch & Iron'] = starch;
  return out;
};

const LAUNDRY_ITEMS = [
  { name: 'Shirt', category: 'Tops', prices: p(800, 1500, 400, 1000) },
  { name: 'T-shirt / Polo', category: 'Tops', prices: p(600, null, 300, null) },
  { name: 'Blouse', category: 'Tops', prices: p(800, 1500, 400, null) },
  { name: 'Trousers', category: 'Bottoms', prices: p(900, 1500, 400, 1100) },
  { name: 'Jeans', category: 'Bottoms', prices: p(1000, null, 500, null) },
  { name: 'Skirt', category: 'Bottoms', prices: p(800, 1500, 400, null) },
  { name: 'Suit (2-piece)', category: 'Formal', prices: p(null, 4500, 2000, null) },
  { name: 'Suit (3-piece)', category: 'Formal', prices: p(null, 6000, 2500, null) },
  { name: 'Jacket / Blazer', category: 'Formal', prices: p(null, 3000, 1200, null) },
  { name: 'Gown / Dress', category: 'Formal', prices: p(1500, 3000, 800, null) },
  { name: 'Wedding gown', category: 'Formal', prices: p(null, 20000, null, null) },
  { name: 'Agbada (3-piece)', category: 'Native', prices: p(4000, 6000, 2000, 5000) },
  { name: 'Kaftan / Senator', category: 'Native', prices: p(1500, 3000, 800, 2000) },
  { name: 'Buba & Sokoto', category: 'Native', prices: p(2000, 3500, 1000, 2500) },
  { name: 'Iro & Buba', category: 'Native', prices: p(2000, 3500, 1000, 2500) },
  { name: 'Cap / Gele', category: 'Native', prices: p(500, 1000, 300, 600) },
  { name: 'Bedsheet (with pillowcases)', category: 'Household', unit: 'set', prices: p(2000, null, 1000, null) },
  { name: 'Duvet', category: 'Household', prices: p(5000, 7000, null, null) },
  { name: 'Blanket', category: 'Household', prices: p(4000, 6000, null, null) },
  { name: 'Curtain (per panel)', category: 'Household', prices: p(2500, 4000, 1500, null) },
  { name: 'Towel', category: 'Household', prices: p(700, null, null, null) },
  { name: 'Sneakers / Canvas', category: 'Shoes', unit: 'pair', prices: p(3000, null, null, null) },
  { name: 'Mixed laundry (per kg)', category: 'By weight', unit: 'kg', prices: p(1200, null, null, null) },
];

const CLEANING_SERVICES = [
  {
    name: 'Standard cleaning', description: 'Regular cleaning of a lived-in home.',
    basePrice: 15000, perBedroom: 5000, perBathroom: 3000, hours: 3,
    checklist: ['Sweep and mop all floors', 'Dust surfaces and furniture', 'Clean kitchen counters and sink', 'Clean and disinfect toilets and bathrooms', 'Empty bins', 'Make beds', 'Wipe doors and switches'],
  },
  {
    name: 'Deep cleaning', description: 'Top-to-bottom clean, inside cupboards and hard-to-reach places.',
    basePrice: 35000, perBedroom: 10000, perBathroom: 6000, hours: 6,
    checklist: ['Everything in standard cleaning', 'Scrub tiles and grout', 'Clean inside kitchen cabinets', 'Degrease cooker and extractor', 'Wash windows and burglary proofs (inside)', 'Dust ceiling fans and light fittings', 'Clean behind and under furniture', 'Descale taps and showers'],
  },
  {
    name: 'Post-construction cleaning', description: 'After building or renovation work: dust, paint and cement removal.',
    basePrice: 60000, perBedroom: 15000, perBathroom: 8000, hours: 8,
    checklist: ['Remove debris and packaging', 'Remove paint and cement stains', 'Clean windows, frames and tracks', 'Vacuum and wipe all surfaces', 'Clean all fittings and switches', 'Scrub and mop floors twice'],
  },
  {
    name: 'Move-in / move-out cleaning', description: 'Empty house, ready for the next occupant.',
    basePrice: 40000, perBedroom: 10000, perBathroom: 6000, hours: 6,
    checklist: ['Clean inside all wardrobes and cabinets', 'Clean kitchen fully, inside and out', 'Scrub bathrooms and toilets', 'Wash walls where marked', 'Clean windows and doors', 'Mop all floors'],
  },
  {
    name: 'Office cleaning', description: 'Workspace cleaning, by visit.',
    basePrice: 25000, perBedroom: 0, perBathroom: 4000, hours: 4,
    checklist: ['Empty bins and replace liners', 'Dust desks and equipment', 'Clean kitchen/break area', 'Clean and restock toilets', 'Vacuum or mop floors', 'Wipe glass doors and partitions'],
  },
];

const CLEANING_EXTRAS = [
  { name: 'Inside fridge', price: 5000 },
  { name: 'Inside oven', price: 5000 },
  { name: 'Windows (outside)', price: 8000 },
  { name: 'Balcony / terrace', price: 5000 },
  { name: 'Laundry & ironing (per load)', price: 4000 },
  { name: 'Sofa / upholstery wash (per seat)', price: 3000 },
  { name: 'Rug / carpet wash', price: 7000 },
];

// The company's settings, filled with defaults for anything never set.
async function settingsFor(companyId) {
  const ServiceSettings = require('../models/ServiceSettings');
  let s = await ServiceSettings.findOne({ companyId });
  if (!s) {
    try {
      s = await ServiceSettings.create({ companyId });
    } catch (e) {
      if (e.code !== 11000) throw e;
      s = await ServiceSettings.findOne({ companyId });
    }
  }
  let changed = false;
  if (!s.laundry?.services) { s.set('laundry.services', LAUNDRY_SERVICES); changed = true; }
  if (!s.laundry?.items) { s.set('laundry.items', LAUNDRY_ITEMS); changed = true; }
  if (!s.cleaning?.services) { s.set('cleaning.services', CLEANING_SERVICES); changed = true; }
  if (!s.cleaning?.extras) { s.set('cleaning.extras', CLEANING_EXTRAS); changed = true; }
  if (changed) await s.save();
  return s;
}

module.exports = { settingsFor, LAUNDRY_SERVICES, LAUNDRY_ITEMS, CLEANING_SERVICES, CLEANING_EXTRAS };
