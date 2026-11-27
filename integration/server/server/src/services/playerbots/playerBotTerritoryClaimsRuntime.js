"use strict";

// Territory claims for the Territory Map add-on. Claims are null-sec only. A
// corporation first anchors an Upwell station (a dockable structure) in
// null-sec; that system becomes its anchor claim, and it may then claim up to
// MAX_CLAIMS systems in all, each linked by stargate to one it already holds.
// Bot-run corporations claim on their own, one system at a time; the operator
// can claim and unclaim for any corporation from the map. Systems claimed by
// more than one corporation are contested; a bot-run claimant declares a
// normal EveJS corporation war on its rival (bill, 24-hour start timer and
// Crimewatch rules all apply), and its war pilots patrol contested systems.
// Losing the last Upwell station in its claims drops a corporation's claims.

const STORE_PATH = "/_territoryClaims";
const MAX_CLAIMS = 5;
const WAR_ATTEMPT_INTERVAL_MS = 30 * 60 * 1000;
const EXPANSION_INTERVAL_MS = 30 * 60 * 1000;
const KSPACE_MAX_SYSTEM_ID = 31_000_000;
const STRUCTURE_STATE_ANCHORED_MIN = 100; // states below are unknown, unanchored and anchoring

let cache = null;
const lastWarAttempt = new Map(); // "a:b" -> { atMs, reason }
const lastExpansionAtMs = new Map(); // corporationID -> ms

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

function systemSecurity(systemID) {
  try {
    const system = require("../../space/worldData").getSolarSystemByID(systemID);
    if (!system) return null;
    const security = Number(system.security ?? system.securityStatus);
    return Number.isFinite(security) ? security : null;
  } catch (_) { return null; }
}

function isNullsec(systemID) {
  const security = systemSecurity(systemID);
  return systemID < KSPACE_MAX_SYSTEM_ID && security !== null && security <= 0;
}

function isAnchoredUpwellStation(structure) {
  if (!structure || structure.destroyedAt || structure.unanchoring) return false;
  if (Number(structure.state) < STRUCTURE_STATE_ANCHORED_MIN) return false;
  try {
    const type = require("../structure/structureState").getStructureTypeByID(positiveID(structure.typeID));
    return Boolean(type && type.dockable);
  } catch (_) { return false; }
}

function listStructures() {
  const structureState = require("../structure/structureState");
  return typeof structureState.peekStructures === "function" ? structureState.peekStructures() : structureState.listStructures();
}

// corporationID -> Set of null-sec systems with its anchored Upwell stations.
function anchorsByCorporation() {
  const anchors = new Map();
  for (const structure of listStructures()) {
    const corporationID = positiveID(structure && (structure.ownerCorpID || structure.ownerID));
    const systemID = positiveID(structure && structure.solarSystemID);
    if (!corporationID || !systemID || !isNullsec(systemID) || !isAnchoredUpwellStation(structure)) continue;
    if (!anchors.has(corporationID)) anchors.set(corporationID, new Set());
    anchors.get(corporationID).add(systemID);
  }
  return anchors;
}

function anchorSystems(corporationID) {
  return anchorsByCorporation().get(corporationID) || new Set();
}

// Keep only claims connected to the first one.
function connectedFromFirst(systems) {
  if (!systems.length) return [];
  const remaining = new Set(systems);
  const reached = new Set([systems[0]]);
  const queue = [systems[0]];
  while (queue.length) {
    for (const next of neighbours(queue.shift())) {
      if (remaining.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }
  return systems.filter((id) => reached.has(id));
}

function claim(corporationIDValue, systemIDValue) {
  const corporationID = positiveID(corporationIDValue);
  const systemID = positiveID(systemIDValue);
  if (!corporationID || !systemID) return { success: false, statusCode: 400, message: "A corporation and a system are required." };
  if (systemSecurity(systemID) === null) return { success: false, statusCode: 404, message: "Unknown solar system." };
  if (!isNullsec(systemID)) return { success: false, statusCode: 409, message: "Only null-sec systems can be claimed." };
  if (!require("../corporation/corporationState").getCorporationRecord(corporationID)) {
    return { success: false, statusCode: 404, message: "Unknown corporation." };
  }
  const state = load();
  const held = state.claims[corporationID] || [];
  if (held.includes(systemID)) return { success: false, statusCode: 409, message: "The corporation already claims this system." };
  if (held.length >= MAX_CLAIMS) return { success: false, statusCode: 409, message: `A corporation can claim at most ${MAX_CLAIMS} systems.` };
  if (!held.length) {
    const anchors = anchorSystems(corporationID);
    if (!anchors.has(systemID)) {
      return { success: false, statusCode: 409, message: anchors.size
        ? "The first claim must be a null-sec system where the corporation has an anchored Upwell station."
        : "The corporation needs an anchored Upwell station in null-sec before it can claim territory." };
    }
  }
  if (held.length && !held.some((id) => neighbours(id).has(systemID))) {
    return { success: false, statusCode: 409, message: "The system must be linked by stargate to one the corporation already claims." };
  }
  save({ claims: { ...state.claims, [corporationID]: [...held, systemID] } });
  return { success: true, corporationID, systems: [...held, systemID] };
}

// Removing a claim also drops claims that are no longer connected to the
// anchor claim; removing the anchor claim drops them all.
function unclaim(corporationIDValue, systemIDValue) {
  const corporationID = positiveID(corporationIDValue);
  const systemID = positiveID(systemIDValue);
  const state = load();
  const held = state.claims[corporationID] || [];
  if (!held.includes(systemID)) return { success: false, statusCode: 404, message: "The corporation does not claim this system." };
  const kept = held[0] === systemID ? [] : connectedFromFirst(held.filter((id) => id !== systemID));
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

// Director global maintenance. Claims whose anchor station is gone move to
// another claimed system with a station, or are dropped. Bot-run corporations
// with a station claim their anchor system, then one neighbouring null-sec
// system per interval up to MAX_CLAIMS, preferring systems nobody claims.
function reconcileClaims(bots = [], options = {}) {
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  const anchors = anchorsByCorporation();
  const state = load();
  const claims = {};
  const summary = { dropped: 0, claimed: 0 };
  for (const [corporationID, systems] of Object.entries(state.claims)) {
    const held = anchors.get(Number(corporationID)) || new Set();
    const nullsec = systems.filter((id) => isNullsec(id));
    const anchorIndex = nullsec.findIndex((id) => held.has(id));
    const kept = anchorIndex < 0 ? [] : connectedFromFirst([nullsec[anchorIndex], ...nullsec.filter((_, i) => i !== anchorIndex)]);
    summary.dropped += systems.length - kept.length;
    if (kept.length) claims[corporationID] = kept;
  }
  const autoclaim = String(process.env.EVEJS_PLAYER_BOTS_TERRITORY_AUTOCLAIM ?? "1").trim() !== "0";
  if (autoclaim) {
    const rosterIDs = new Set((Array.isArray(bots) ? bots : []).map((bot) => Number(bot.characterID)));
    const corporationState = require("../corporation/corporationState");
    const claimants = new Map();
    for (const [corporationID, systems] of Object.entries(claims)) {
      for (const id of systems) claimants.set(id, (claimants.get(id) || 0) + 1);
    }
    for (const [corporationID, stations] of [...anchors].sort((a, b) => a[0] - b[0])) {
      const record = corporationState.getCorporationRecord(corporationID) || {};
      if (record.isNPC === true || !rosterIDs.has(Number(record.ceoID))) continue; // bot-run only
      const held = claims[corporationID] || [];
      if (held.length >= MAX_CLAIMS) continue;
      if (held.length && nowMs - (lastExpansionAtMs.get(corporationID) || 0) < EXPANSION_INTERVAL_MS) continue;
      let next = 0;
      if (!held.length) {
        next = Math.min(...stations);
      } else {
        const candidates = new Set();
        for (const id of held) for (const neighbour of neighbours(id)) {
          if (!held.includes(neighbour) && isNullsec(neighbour)) candidates.add(neighbour);
        }
        next = [...candidates].sort((a, b) => Number(stations.has(b)) - Number(stations.has(a)) ||
          (claimants.get(a) || 0) - (claimants.get(b) || 0) || a - b)[0] || 0;
      }
      if (!next) continue;
      claims[corporationID] = [...held, next];
      claimants.set(next, (claimants.get(next) || 0) + 1);
      lastExpansionAtMs.set(corporationID, nowMs);
      summary.claimed += 1;
    }
  }
  if (JSON.stringify(claims) !== JSON.stringify(state.claims)) save({ claims });
  return summary;
}

function structureHeadquarters(corporationID) {
  const structure = listStructures().find((entry) => entry &&
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
  reconcileClaims,
  anchorSystems: (id) => [...anchorSystems(positiveID(id))],
  _testing: { reset: () => { cache = null; adjacency = null; lastWarAttempt.clear(); lastExpansionAtMs.clear(); } },
};
