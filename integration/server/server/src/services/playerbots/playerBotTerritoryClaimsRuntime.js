"use strict";

// Territory claims for the Territory Map add-on. An operator claims solar
// systems for a corporation: at most MAX_CLAIMS per corporation, the first at
// the corporation's headquarters (its station or one of its structures), each
// further one linked by stargate to a system it already holds. Systems claimed
// by more than one corporation are contested; a bot-run claimant declares a
// normal EveJS corporation war on its rival (bill, 24-hour start timer and
// Crimewatch rules all apply), and its war pilots patrol contested systems.

const STORE_PATH = "/_territoryClaims";
const MAX_CLAIMS = 5;
const WAR_ATTEMPT_INTERVAL_MS = 30 * 60 * 1000;

let cache = null;
const lastWarAttempt = new Map(); // "a:b" -> { atMs, reason }

const positiveID = (value) => {
  const id = Math.trunc(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function repo() {
  return require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
}

function load() {
  if (cache) return cache;
  const stored = repo().read("playerBots", STORE_PATH);
  const claims = {};
  const raw = stored.success && stored.data && stored.data.claims;
  for (const [corporationID, systems] of Object.entries(raw || {})) {
    const id = positiveID(corporationID);
    const list = (Array.isArray(systems) ? systems : []).map(positiveID).filter(Boolean).slice(0, MAX_CLAIMS);
    if (id && list.length) claims[id] = [...new Set(list)];
  }
  cache = { claims };
  return cache;
}

function save(state) {
  const r = repo();
  r.ensureTable("playerBots");
  const result = r.write("playerBots", STORE_PATH, { claims: state.claims, updatedAt: new Date().toISOString() });
  if (!result.success) throw new Error(result.errorMsg || "TERRITORY_WRITE_FAILED");
  r.flushTableSync("playerBots");
  cache = state;
}

let adjacency = null;
function neighbours(systemID) {
  if (!adjacency) {
    adjacency = new Map();
    for (const [a, b] of require("./playerBotMapApiRuntime").buildStaticMap().links || []) {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    }
  }
  return adjacency.get(systemID) || new Set();
}

function systemExists(systemID) {
  try { return Boolean(require("../../space/worldData").getSolarSystemByID(systemID)); } catch (_) { return neighbours(systemID).size > 0; }
}

// Systems that count as a corporation's headquarters for its first claim.
function headquartersSystems(corporationID) {
  const systems = new Set();
  const record = require("../corporation/corporationState").getCorporationRecord(corporationID);
  if (!record) return null;
  try {
    const station = record.stationID && require("../../space/worldData").getStationByID(record.stationID);
    if (station && positiveID(station.solarSystemID)) systems.add(positiveID(station.solarSystemID));
  } catch (_) { /* no NPC headquarters */ }
  try {
    for (const structure of require("../structure/structureState").listStructures()) {
      if (!structure || structure.destroyedAt || structure.unanchoring) continue;
      if (positiveID(structure.ownerCorpID || structure.ownerID) !== corporationID) continue;
      if (positiveID(structure.solarSystemID)) systems.add(positiveID(structure.solarSystemID));
    }
  } catch (_) { /* structures unavailable */ }
  return systems;
}

function claim(corporationIDValue, systemIDValue) {
  const corporationID = positiveID(corporationIDValue);
  const systemID = positiveID(systemIDValue);
  if (!corporationID || !systemID) return { success: false, statusCode: 400, message: "A corporation and a system are required." };
  if (!systemExists(systemID)) return { success: false, statusCode: 404, message: "Unknown solar system." };
  const hq = headquartersSystems(corporationID);
  if (!hq) return { success: false, statusCode: 404, message: "Unknown corporation." };
  const state = load();
  const held = state.claims[corporationID] || [];
  if (held.includes(systemID)) return { success: false, statusCode: 409, message: "The corporation already claims this system." };
  if (held.length >= MAX_CLAIMS) return { success: false, statusCode: 409, message: `A corporation can claim at most ${MAX_CLAIMS} systems.` };
  if (!held.length && !hq.has(systemID)) {
    return { success: false, statusCode: 409, message: hq.size
      ? "The first claim must be the corporation's headquarters system (its station or one of its structures)."
      : "The corporation has no headquarters station or structure to claim from." };
  }
  if (held.length && !held.some((id) => neighbours(id).has(systemID))) {
    return { success: false, statusCode: 409, message: "The system must be linked by stargate to one the corporation already claims." };
  }
  save({ claims: { ...state.claims, [corporationID]: [...held, systemID] } });
  return { success: true, corporationID, systems: [...held, systemID] };
}

// Removing a claim also drops claims that are no longer connected to the
// headquarters claim; removing the headquarters claim drops them all.
function unclaim(corporationIDValue, systemIDValue) {
  const corporationID = positiveID(corporationIDValue);
  const systemID = positiveID(systemIDValue);
  const state = load();
  const held = state.claims[corporationID] || [];
  if (!held.includes(systemID)) return { success: false, statusCode: 404, message: "The corporation does not claim this system." };
  let kept = [];
  if (held[0] !== systemID) {
    const remaining = new Set(held.filter((id) => id !== systemID));
    const reached = new Set([held[0]]);
    const queue = [held[0]];
    while (queue.length) {
      for (const next of neighbours(queue.shift())) {
        if (remaining.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    kept = held.filter((id) => reached.has(id));
  }
  const claims = { ...state.claims };
  if (kept.length) claims[corporationID] = kept; else delete claims[corporationID];
  save({ claims });
  return { success: true, corporationID, systems: kept, removed: held.filter((id) => !kept.includes(id)) };
}

function getClaims() {
  return load().claims;
}

function getContested() {
  const bySystem = new Map();
  for (const [corporationID, systems] of Object.entries(load().claims)) {
    for (const systemID of systems) {
      if (!bySystem.has(systemID)) bySystem.set(systemID, []);
      bySystem.get(systemID).push(Number(corporationID));
    }
  }
  const contested = {};
  for (const [systemID, corporations] of bySystem) if (corporations.length > 1) contested[systemID] = corporations;
  return contested;
}

function getContestedSystemsForCorporation(corporationID) {
  const id = positiveID(corporationID);
  return Object.entries(getContested())
    .filter(([, corporations]) => corporations.includes(id))
    .map(([systemID]) => Number(systemID));
}

function contestedPairs() {
  const pairs = new Map();
  for (const [systemID, corporations] of Object.entries(getContested())) {
    for (let i = 0; i < corporations.length; i += 1) {
      for (let j = i + 1; j < corporations.length; j += 1) {
        const key = pairKey(corporations[i], corporations[j]);
        if (!pairs.has(key)) pairs.set(key, { left: corporations[i], right: corporations[j], systems: [] });
        pairs.get(key).systems.push(Number(systemID));
      }
    }
  }
  return [...pairs.values()];
}

function allianceOf(corporationID) {
  try { return positiveID((require("../corporation/corporationState").getCorporationRecord(corporationID) || {}).allianceID); } catch (_) { return 0; }
}

// A war between the two corporations or their alliances.
function findWar(wars, left, right) {
  const leftOwners = new Set([left, allianceOf(left)].filter(Boolean));
  const rightOwners = new Set([right, allianceOf(right)].filter(Boolean));
  return wars.listAllWars().find((war) => !war.timeFinished &&
    ((leftOwners.has(Number(war.declaredByID)) && rightOwners.has(Number(war.againstID))) ||
     (rightOwners.has(Number(war.declaredByID)) && leftOwners.has(Number(war.againstID)))));
}

// War status for every contested pair, for the map.
function getTerritoryWars() {
  const wars = require("../corporation/warRuntimeState");
  const out = {};
  for (const pair of contestedPairs()) {
    const key = pairKey(pair.left, pair.right);
    const war = findWar(wars, pair.left, pair.right);
    const attempt = lastWarAttempt.get(key);
    out[key] = war
      ? { warID: positiveID(war.warID), declaredByID: Number(war.declaredByID), againstID: Number(war.againstID), systems: pair.systems }
      : { warID: 0, systems: pair.systems, pending: attempt ? attempt.reason : "waiting" };
  }
  return out;
}

function structureHeadquarters(corporationID) {
  const structure = require("../structure/structureState").listStructures().find((entry) => entry &&
    !entry.destroyedAt && !entry.unanchoring && positiveID(entry.ownerCorpID || entry.ownerID) === corporationID);
  return structure ? positiveID(structure.structureID || structure.itemID) : 0;
}

// Director global maintenance: declare at most one territory war per pass.
async function declareTerritoryWars(bots = [], options = {}) {
  if (String(process.env.EVEJS_PLAYER_BOTS_TERRITORY_WARS ?? "1").trim() === "0") return { declared: false, reason: "disabled" };
  const pairs = contestedPairs();
  if (!pairs.length) return { declared: false, reason: "no-contested-claims" };
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  const excluded = options.humanControlledBotIDs instanceof Set ? options.humanControlledBotIDs : new Set();
  const conflict = require("./playerBotStructureConflictWarRuntime");
  const wars = require("../corporation/warRuntimeState");
  for (const pair of pairs) {
    const key = pairKey(pair.left, pair.right);
    if (findWar(wars, pair.left, pair.right)) { lastWarAttempt.delete(key); continue; }
    if (allianceOf(pair.left) && allianceOf(pair.left) === allianceOf(pair.right)) {
      lastWarAttempt.set(key, { atMs: nowMs, reason: "same-alliance" });
      continue;
    }
    const previous = lastWarAttempt.get(key);
    if (previous && nowMs - previous.atMs < WAR_ATTEMPT_INTERVAL_MS) continue;
    let reason = "no-bot-run-claimant-with-war-headquarters";
    for (const [declarerID, targetID] of [[pair.left, pair.right], [pair.right, pair.left]]) {
      const headquartersID = structureHeadquarters(declarerID);
      if (!headquartersID) continue;
      const director = conflict.chooseWarDirector(bots, declarerID, excluded);
      if (!director) { reason = "no-corporation-war-director"; continue; }
      try {
        if (!await conflict.ensureWarTreasury(bots, declarerID, targetID, excluded)) { reason = "war-treasury-below-reserve"; continue; }
        await new (require("../corporation/corpRegistryRuntime"))().Handle_DeclareWarAgainst([targetID, headquartersID], director.session);
      } catch (error) {
        reason = String(error && error.message || error).slice(0, 120);
        continue;
      }
      const war = findWar(wars, declarerID, targetID);
      if (!war) { reason = "war-authority-did-not-confirm-declaration"; continue; }
      lastWarAttempt.delete(key);
      return { declared: true, warID: positiveID(war.warID), declaringCorporationID: declarerID, opposingCorporationID: targetID, systems: pair.systems };
    }
    lastWarAttempt.set(key, { atMs: nowMs, reason });
  }
  return { declared: false, reason: "no-declarable-territory-war" };
}

module.exports = {
  MAX_CLAIMS,
  claim,
  unclaim,
  getClaims,
  getContested,
  getContestedSystemsForCorporation,
  getTerritoryWars,
  declareTerritoryWars,
  headquartersSystems: (id) => [...(headquartersSystems(positiveID(id)) || [])],
  _testing: { reset: () => { cache = null; adjacency = null; lastWarAttempt.clear(); } },
};
