'use strict';

// Knowledge the customer-facing AI (website chat widget, WhatsApp bot) may
// draw on: chunks of the company's documents marked customerFacing only.
// Everything else in the knowledge base stays internal to the team.
const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');

async function customerFacingChunks(companyId) {
  const ids = await Document.find({ companyId, customerFacing: true, managersOnly: { $ne: true } }).distinct('_id');
  if (!ids.length) return [];
  return DocumentChunk.find({ companyId, documentId: { $in: ids } }).lean();
}

module.exports = { customerFacingChunks };
