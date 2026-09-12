'use strict';

const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');
const Company = require('../models/Company');
const logger = require('../utils/logger');

// Only wire up Google OAuth when credentials are present. Without this guard a
// missing GOOGLE_CLIENT_ID makes `new GoogleStrategy()` throw at require time,
// which crashes the whole server on boot (every route then 404s / 502s).
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

async function verifyGoogleProfile(accessToken, refreshToken, profile, done) {
  try {
    const email = profile.emails?.[0]?.value;
    const name = profile.displayName;
    const avatar = profile.photos?.[0]?.value;

    if (!email) return done(new Error('No email from Google'), null);

    // Check if user already exists
    let user = await User.findOne({ email });

    if (user) {
      let dirty = false;
      if (!user.avatar && avatar) { user.avatar = avatar; dirty = true; }
      // Signing in with Google proves ownership of the email
      if (!user.emailVerified) {
        user.emailVerified = true;
        user.emailVerifyToken = undefined;
        user.emailVerifyExpires = undefined;
        dirty = true;
      }
      if (dirty) await user.save({ validateBeforeSave: false });
      return done(null, user);
    }

    // New user — create company + user
    const companyName = `${name}'s Workspace`;
    const tempUser = new User({ name, email });

    const company = await Company.create({
      companyName,
      owner: tempUser._id,
      storeEnabled: true, // store page live from day one, same as email signup
    });

    user = await User.create({
      name,
      email,
      password: crypto.randomBytes(32).toString('hex'), // random unusable password
      role: 'company_owner',
      companyId: company._id,
      status: 'active',
      avatar,
      emailVerified: true, // Google already verified the email
    });

    company.owner = user._id;
    await company.save();

    logger.info(`New user via Google OAuth: ${email}`);
    done(null, user);
  } catch (err) {
    logger.error('Google OAuth error:', err);
    done(err, null);
  }
}

if (googleEnabled) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${(process.env.API_URL || 'https://businessai-backend-6g8l.onrender.com').replace(/\/+$/, '')}/api/v1/auth/google/callback`,
  }, verifyGoogleProfile));

  passport.serializeUser((user, done) => done(null, user._id));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  });

  logger.info('Google OAuth strategy registered');
} else {
  logger.warn('Google OAuth disabled — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it');
}

module.exports = passport;
module.exports.googleEnabled = googleEnabled;
