'use strict';

// User text used inside a MongoDB $regex: match it literally, so a search
// box can't run a pathological pattern against the database.
module.exports = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
