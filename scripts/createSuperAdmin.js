'use strict';

/**
 * Promote an existing user to super_admin, or create a new super_admin.
 *
 * Usage (from the backend/ folder, with MONGODB_URI in the environment or .env):
 *
 *   node scripts/createSuperAdmin.js <email> [password] [name]
 *
 * or with env vars:
 *
 *   SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD=secret123 \
 *   SUPERADMIN_NAME="Henry" node scripts/createSuperAdmin.js
 *
 * - If the email already exists → its role becomes super_admin and status active
 *   (password only changes if you pass one).
 * - If it doesn't exist → a new super_admin is created (password required,
 *   min 8 chars). It has no company — that's expected for a platform admin.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

async function main() {
  const email = (process.argv[2] || process.env.SUPERADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.argv[3] || process.env.SUPERADMIN_PASSWORD || '';
  const name = process.argv[4] || process.env.SUPERADMIN_NAME || 'Super Admin';

  if (!email) {
    console.error('❌  Provide an email: node scripts/createSuperAdmin.js <email> [password] [name]');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('❌  MONGODB_URI is not set (put it in backend/.env or the environment).');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅  Connected to MongoDB');

  let user = await User.findOne({ email }).select('+password');

  if (user) {
    user.role = 'super_admin';
    user.status = 'active';
    if (password) {
      if (password.length < 8) throw new Error('Password must be at least 8 characters');
      user.password = password; // hashed by the pre-save hook
    }
    await user.save({ validateBeforeSave: false });
    console.log(`✅  Promoted existing user to super_admin: ${email}`);
    if (password) console.log('✅  Password updated');
  } else {
    if (!password || password.length < 8) {
      throw new Error('New super admin needs a password of at least 8 characters (2nd argument).');
    }
    user = await User.create({
      name,
      email,
      password,
      role: 'super_admin',
      status: 'active',
      emailVerified: true,
    });
    console.log(`✅  Created new super_admin: ${email}`);
  }

  console.log('\n   id:    ', user._id.toString());
  console.log('   email: ', user.email);
  console.log('   role:  ', user.role);
  console.log('\n   Log in at your app with this email + password, then open /admin\n');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ ', err.message);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
