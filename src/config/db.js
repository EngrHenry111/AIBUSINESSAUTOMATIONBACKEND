'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

async function connectDB(retries = 0) {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
    });

    logger.info(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected. Attempting reconnect...');
      setTimeout(() => connectDB(), RETRY_DELAY);
    });

  } catch (err) {
    if (retries < MAX_RETRIES) {
      logger.warn(`MongoDB connection failed. Retry ${retries + 1}/${MAX_RETRIES} in ${RETRY_DELAY / 1000}s`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
      return connectDB(retries + 1);
    }
    logger.error('MongoDB connection failed after max retries:', err);
    throw err;
  }
}

module.exports = connectDB;
