'use strict';

/**
 * Daily.co video rooms for appointments.
 * Requires DAILY_API_KEY. DAILY_DOMAIN (your "*.daily.co" subdomain) is only
 * needed by getRoomUrl(); createRoom() returns the canonical URL from the API.
 */

const axios = require('axios');
const logger = require('../utils/logger');

const DAILY_BASE = 'https://api.daily.co/v1';
const ROOM_TTL_SECONDS = 2 * 60 * 60; // 2 hours

function notConfigured() {
  const err = new Error('Video calling is not configured. Set DAILY_API_KEY.');
  err.statusCode = 503;
  return err;
}

function api() {
  if (!process.env.DAILY_API_KEY) throw notConfigured();
  return axios.create({
    baseURL: DAILY_BASE,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

const roomName = (appointmentId) => `bizlyai-${appointmentId}`;

// ── Create (or fetch, if it already exists) a room for an appointment ──────
async function createRoom(appointmentId) {
  const name = roomName(appointmentId);
  const exp = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;

  try {
    const { data } = await api().post('/rooms', {
      name,
      privacy: 'public',
      properties: {
        exp,
        max_participants: 10,
        enable_chat: true,
        enable_screenshare: true,
      },
    });
    return { roomName: data.name, roomUrl: data.url };
  } catch (err) {
    // A room with this name already exists — reuse it.
    const body = JSON.stringify(err.response?.data || '');
    if (err.response?.status === 400 && /already exists/i.test(body)) {
      const { data } = await api().get(`/rooms/${name}`);
      return { roomName: data.name, roomUrl: data.url };
    }
    logger.error('Daily createRoom failed:', err.response?.data || err.message);
    throw err;
  }
}

// ── Delete a room ────────────────────────────────────────────────────────
async function deleteRoom(name) {
  try {
    await api().delete(`/rooms/${name}`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) return true; // already gone
    logger.error('Daily deleteRoom failed:', err.response?.data || err.message);
    throw err;
  }
}

// ── Deterministic room URL (no API call) ─────────────────────────────────
function getRoomUrl(appointmentId) {
  if (!process.env.DAILY_DOMAIN) return null;
  return `https://${process.env.DAILY_DOMAIN}.daily.co/${roomName(appointmentId)}`;
}

module.exports = { createRoom, deleteRoom, getRoomUrl, roomName };
