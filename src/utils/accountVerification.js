'use strict';

// Verification emails never block access, but the "please verify" banner
// should still go away eventually for accounts that simply never click the
// link (delivery issue, spam filter, etc.) — auto-clear it after a grace
// period instead of nagging forever.
const User = require('../models/User');
const logger = require('./logger');

const GRACE_DAYS = 7;

async function autoVerifyOldAccounts() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - GRACE_DAYS);

    const result = await User.updateMany(
      { emailVerified: false, createdAt: { $lt: cutoff } },
      { $set: { emailVerified: true } },
    );

    if (result.modifiedCount > 0) {
      logger.info(`✅ Auto-verified ${result.modifiedCount} account(s) older than ${GRACE_DAYS} days`);
    }
    return result.modifiedCount;
  } catch (err) {
    logger.error(`autoVerifyOldAccounts failed: ${err.message}`);
    return 0;
  }
}

module.exports = { autoVerifyOldAccounts };
