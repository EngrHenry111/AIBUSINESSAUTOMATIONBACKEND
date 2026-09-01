'use strict';

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');
const Company = require('../models/Company');
const logger = require('../utils/logger');

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.API_URL || 'https://businessai-backend-6g8l.onrender.com'}/api/v1/auth/google/callback`,
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    const name = profile.displayName;
    const avatar = profile.photos?.[0]?.value;

    if (!email) return done(new Error('No email from Google'), null);

    // Check if user already exists
    let user = await User.findOne({ email });

    if (user) {
      // Update avatar if not set
      if (!user.avatar && avatar) {
        user.avatar = avatar;
        await user.save({ validateBeforeSave: false });
      }
      return done(null, user);
    }

    // New user — create company + user
    const companyName = `${name}'s Workspace`;
    const tempUser = new User({ name, email });

    const company = await Company.create({
      companyName,
      owner: tempUser._id,
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
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;