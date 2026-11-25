"use strict";

const HAULER_TYPE_IDS = Object.freeze([
  648, 649, 650, 652, 653, 657, 1944, 19744, // Standard empire industrials
  81008, // Squall
  12729, 12731, 12733, 12735, 12743, 12745, 12747, 12753, // Advanced empire transports
  81046, 81047, // Deluge and Torrent
]);

// Freighters and Jump Freighters: the capital haulers at the end of the
// hauler tree. Traders flying one take an escort fleet with them.
const FREIGHTER_GROUP_ID = 513;
const JUMP_FREIGHTER_GROUP_ID = 902;
const SUPER_HAULER_TYPE_IDS = Object.freeze([
  20183, 20185, 20187, 20189, // Providence, Charon, Obelisk, Fenrir
  28844, 28846, 28848, 28850, // Rhea, Nomad, Anshar, Ark
]);
const SUPER_HAULER_SET = new Set(SUPER_HAULER_TYPE_IDS);

function isSuperHauler(typeID) {
  return SUPER_HAULER_SET.has(Math.trunc(Number(typeID)) || 0);
}

module.exports = { FREIGHTER_GROUP_ID, HAULER_TYPE_IDS, JUMP_FREIGHTER_GROUP_ID, SUPER_HAULER_TYPE_IDS, isSuperHauler };
