'use strict';

const mongoose = require('mongoose');

// Last register serial issued for a class level in a session — $inc'd so two
// simultaneous enrolments into JSS 1 can never get the same number.
const schoolRegCounterSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  session: { type: String, required: true },
  levelCode: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

schoolRegCounterSchema.index({ companyId: 1, session: 1, levelCode: 1 }, { unique: true });

module.exports = mongoose.model('SchoolRegCounter', schoolRegCounterSchema);
