'use strict';

const mongoose = require('mongoose');

// "Frequently bought together" tracking — one document per unordered pair of
// products that has ever appeared together in the same order. productA/
// productB are canonicalized (A's string id always sorts before B's) so the
// same pair is never stored twice as both (X,Y) and (Y,X).
const productPairSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  productA: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productB: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  count: { type: Number, default: 0 },
}, { timestamps: true });

productPairSchema.index({ companyId: 1, productA: 1, productB: 1 }, { unique: true });
productPairSchema.index({ companyId: 1, productA: 1, count: -1 });
productPairSchema.index({ companyId: 1, productB: 1, count: -1 });

module.exports = mongoose.model('ProductPair', productPairSchema);
