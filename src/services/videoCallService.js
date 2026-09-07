'use strict';

/**
 * Jitsi Meet video rooms for appointments.
 *
 * Free and open source — no API key, no account, no payment. A room is just a
 * URL that comes into being the moment someone opens it, and disappears when
 * everyone leaves. Override the server with JITSI_BASE_URL if you self-host.
 */

const BASE_URL = (process.env.JITSI_BASE_URL || 'https://meet.jit.si').replace(/\/+$/, '');

const roomName = (appointmentId) => `bizlyai-${appointmentId}`;
const getRoomUrl = (appointmentId) => `${BASE_URL}/${roomName(appointmentId)}`;

// Kept async + same shape as before so the controller doesn't change.
async function createRoom(appointmentId) {
  return { roomName: roomName(appointmentId), roomUrl: getRoomUrl(appointmentId) };
}

// Jitsi rooms are ephemeral; there is nothing to delete server-side.
async function deleteRoom() {
  return true;
}

module.exports = { createRoom, deleteRoom, getRoomUrl, roomName };
