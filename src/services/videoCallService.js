'use strict';

const JITSI_DOMAIN = 'meet.jit.si';

function getRoomName(appointmentId) {
  return `BizlyAI-${appointmentId}`;
}

function getRoomUrl(appointmentId) {
  return `https://${JITSI_DOMAIN}/${getRoomName(appointmentId)}`;
}

async function createRoom(appointmentId) {
  // Jitsi rooms are created automatically when first person joins
  // No API call needed
  const roomUrl = getRoomUrl(appointmentId);
  const roomName = getRoomName(appointmentId);
  return { roomUrl, roomName };
}

async function deleteRoom(roomName) {
  // Jitsi rooms close automatically when everyone leaves
  return true;
}

module.exports = { createRoom, deleteRoom, getRoomUrl, getRoomName };
