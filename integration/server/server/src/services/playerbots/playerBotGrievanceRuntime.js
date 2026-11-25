"use strict";

// Grievances: how bot corporations answer violence, like player corps do.
// Every attack on a bot by another corporation's pilot (bot or person) is an
// incident against the victim's corporation. Incidents mark the aggressor
// corporation hostile (red) for a while; enough of them in a day and the
// victim corporation declares war, through the normal war authority, bill and
// 24-hour timer. Hostile corporations are fair game for gate camps in low and
// null security space. The dashboard Reputation page lists all of this, with
// the bots' security status, and can mark or clear a corporation by hand.

const TABLE = "playerBots";
const STORE_PATH = "/_grievances";
const INCIDENT_GAP_MS = 2 * 60 * 1000; // one incident per attacker and victim every two minutes
const WINDOW_MS = 24 * 60 * 60 * 1000;
const HOSTILE_AFTER = 2; // incidents in a day that mark the aggressor hostile
const WAR_AFTER = 3; // incidents in a day that bring a war declaration
const HOSTILE_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const WAR_ATTEMPT_MS = 30 * 60 * 1000;
const MAX_INCIDENTS = 50;
const PLAYER_CORPORATION_MIN_ID = 98_000_000; // NPC corporations cannot be at war

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function lazy(path) {
  let cached;
  return () => (cached ||= require(path));
}

const deps = {
  characters: lazy("../character/characterState"),
  corporations: lazy("../corporation/corporationState"),
  wars: lazy("../corporation/warRuntimeState"),
  playerBots: lazy("./playerBotRuntime"),
  warRuntime: lazy("./playerBotStructureConflictWarRuntime"),
  logger: lazy("../../utils/logger"),
  store: () => {
    const repo = require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
    return {
      read() {
        repo.ensureTable(TABLE);
        const result = repo.read(TABLE, STORE_PATH);
        return result.success && result.data && typeof result.data === "object" ? result.data : {};
      },
      write(value) {
        repo.ensureTable(TABLE);
        repo.write(TABLE, STORE_PATH, value);
      },
    };
  },
};

let state = null; // { pairs: { "victim:aggressor": record }, lastWarAttemptAtMs }
const lastIncidentByKey = new Map();

function load() {
  if (state) return state;
  try {
    const data = deps.store().read();
    state = { pairs: {}, lastWarAttemptAtMs: 0, ...JSON.parse(JSON.stringify(data)) };
  } catch {
    state = { pairs: {}, lastWarAttemptAtMs: 0 };
  }
  return state;
}

function save() {
  try { deps.store().write(state); } catch (error) { warn(`could not save grievances: ${error.message}`); }
}

function warn(message) {
  try { deps.logger().warn(`[PlayerBots] Grievances: ${message}`); } catch { /* logging only */ }
}

function corporationOf(characterID) {
  const record = deps.characters().getCharacterRecord(positive(characterID)) || {};
  return { corporationID: positive(record.corporationID), allianceID: positive(record.allianceID) };
}

function allianceOf(corporationID) {
  try {
    return positive((deps.corporations().getCorporationRecord(corporationID) || {}).allianceID);
  } catch {
    return 0;
  }
}

function isBotCharacter(characterID) {
  try {
    const runtime = deps.playerBots();
    return typeof runtime.hasBotProfile === "function" ? runtime.hasBotProfile(positive(characterID)) === true : false;
  } catch {
    return false;
  }
}

function pairKey(victimCorporationID, aggressorCorporationID) {
  return `${victimCorporationID}:${aggressorCorporationID}`;
}

function recentIncidents(record, now = Date.now()) {
  return (record && record.incidents || []).filter((incident) => now - Number(incident.atMs) < WINDOW_MS);
}

// A bot was shot at by another pilot. Returns the updated record or null.
function recordAggression({ victimCharacterID, attackerCharacterID, systemID = 0, whenMs = Date.now() } = {}) {
  const victimID = positive(victimCharacterID);
  const attackerID = positive(attackerCharacterID);
  if (!victimID || !attackerID || victimID === attackerID) return null;
  const victim = corporationOf(victimID);
  const attacker = corporationOf(attackerID);
  if (!victim.corporationID || !attacker.corporationID || victim.corporationID === attacker.corporationID) return null;
  if (attacker.corporationID < PLAYER_CORPORATION_MIN_ID) return null;
  const victimAlliance = victim.allianceID || allianceOf(victim.corporationID);
  const attackerAlliance = attacker.allianceID || allianceOf(attacker.corporationID);
  if (victimAlliance && victimAlliance === attackerAlliance) return null;
  const gapKey = `${victimID}:${attackerID}`;
  const now = Number(whenMs) || Date.now();
  if (now - (lastIncidentByKey.get(gapKey) || 0) < INCIDENT_GAP_MS) return null;
  lastIncidentByKey.set(gapKey, now);
  if (lastIncidentByKey.size > 10_000) lastIncidentByKey.clear();
  const data = load();
  const key = pairKey(victim.corporationID, attacker.corporationID);
  const record = data.pairs[key] || {
    victimCorporationID: victim.corporationID,
    aggressorCorporationID: attacker.corporationID,
    total: 0,
    incidents: [],
    hostileUntilMs: 0,
    manual: "",
    warID: 0,
    byPerson: false,
  };
  record.total += 1;
  record.byPerson = record.byPerson || !isBotCharacter(attackerID);
  record.incidents = [...recentIncidents(record, now), {
    atMs: now, victimCharacterID: victimID, attackerCharacterID: attackerID, systemID: positive(systemID),
  }].slice(-MAX_INCIDENTS);
  if (recentIncidents(record, now).length >= HOSTILE_AFTER && record.manual !== "clear") {
    record.hostileUntilMs = Math.max(Number(record.hostileUntilMs) || 0, now + HOSTILE_FOR_MS);
  }
  record.lastAtMs = now;
  data.pairs[key] = record;
  save();
  return record;
}

// Is the target pilot's corporation hostile to this corporation: at war with
// it, or marked hostile by incidents or by hand?
function isHostileCorporation(corporationID, otherCorporationID, now = Date.now()) {
  const own = positive(corporationID);
  const other = positive(otherCorporationID);
  if (!own || !other || own === other) return false;
  const record = load().pairs[pairKey(own, other)];
  if (record && record.manual === "hostile") return true;
  if (record && record.manual === "clear") return false;
  return Boolean(record && Number(record.hostileUntilMs) > now);
}

// Does this corporation have any hostile corporation marked right now?
function hasActiveHostiles(corporationID) {
  const own = positive(corporationID);
  const now = Date.now();
  return Object.values(load().pairs).some((record) => record.victimCorporationID === own &&
    isHostileCorporation(own, record.aggressorCorporationID, now));
}

function isHostileCharacter(corporationID, characterID) {
  return isHostileCorporation(corporationID, corporationOf(characterID).corporationID);
}

function unfinishedWarBetween(left, right) {
  try {
    const now = BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
    const open = (war) => {
      if (!war.timeFinished) return true;
      try { return BigInt(String(war.timeFinished)) > now; } catch { return true; }
    };
    return deps.wars().listAllWars().find((war) => open(war) &&
      ((positive(war.declaredByID) === left && positive(war.againstID) === right) ||
       (positive(war.declaredByID) === right && positive(war.againstID) === left))) || null;
  } catch {
    return null;
  }
}

// The corporation that has been attacked enough declares war on its
// aggressor, at most one attempt every half hour across the server.
async function declareGrievanceWars(bots = [], options = {}) {
  const data = load();
  const now = Number(options.now) || Date.now();
  if (now - (Number(data.lastWarAttemptAtMs) || 0) < WAR_ATTEMPT_MS) return { declared: false, reason: "waiting" };
  const botCorporationIDs = new Set((Array.isArray(bots) ? bots : []).map((bot) => positive(bot.corporationID)).filter(Boolean));
  const due = Object.values(data.pairs)
    .filter((record) => botCorporationIDs.has(record.victimCorporationID) && record.manual !== "clear" &&
      (recentIncidents(record, now).length >= WAR_AFTER || record.manual === "war") &&
      !unfinishedWarBetween(record.victimCorporationID, record.aggressorCorporationID))
    .sort((left, right) => recentIncidents(right, now).length - recentIncidents(left, now).length);
  if (!due.length) return { declared: false, reason: "no-grievance" };
  data.lastWarAttemptAtMs = now;
  save();
  const record = due[0];
  const warRuntime = deps.warRuntime();
  const excluded = options.humanControlledBotIDs instanceof Set ? options.humanControlledBotIDs : new Set();
  const director = warRuntime.chooseWarDirector(bots, record.victimCorporationID, excluded);
  if (!director) return { declared: false, reason: "no-war-director" };
  const headquarters = require("./playerBotHomeBaseRuntime").getHomeBase(record.victimCorporationID);
  let warHeadquartersID = headquarters && headquarters.kind === "structure" ? positive(headquarters.stationID) : 0;
  if (!warHeadquartersID) {
    try {
      const owned = require("../structure/structureState").listOwnedStructures(record.victimCorporationID, { refresh: false }) || [];
      const structure = owned.find((entry) => entry && !entry.destroyedAt && !entry.unanchoring);
      warHeadquartersID = positive(structure && (structure.structureID || structure.itemID));
    } catch {
      warHeadquartersID = 0;
    }
  }
  if (!warHeadquartersID) return { declared: false, reason: "no-war-headquarters" };
  try {
    if (!await warRuntime.ensureWarTreasury(bots, record.victimCorporationID, record.aggressorCorporationID, excluded)) {
      return { declared: false, reason: "war-treasury-below-reserve" };
    }
    await new (require("../corporation/corpRegistryRuntime"))().Handle_DeclareWarAgainst(
      [record.aggressorCorporationID, warHeadquartersID], director.session,
    );
  } catch (error) {
    return { declared: false, reason: String(error && error.message || error).slice(0, 180) };
  }
  const war = unfinishedWarBetween(record.victimCorporationID, record.aggressorCorporationID);
  if (!war) return { declared: false, reason: "war-authority-did-not-confirm-declaration" };
  record.warID = positive(war.warID);
  record.warDeclaredAtMs = now;
  record.hostileUntilMs = Math.max(Number(record.hostileUntilMs) || 0, now + HOSTILE_FOR_MS);
  save();
  deps.logger().info(`[PlayerBots] Corporation ${record.victimCorporationID} declared war ${record.warID} on ${record.aggressorCorporationID} after ${recentIncidents(record, now).length} attacks on its pilots.`);
  return { declared: true, warID: record.warID, declaringCorporationID: record.victimCorporationID, opposingCorporationID: record.aggressorCorporationID };
}

function corporationName(corporationID) {
  try {
    const record = deps.corporations().getCorporationRecord(corporationID) || {};
    return { name: String(record.corporationName || `Corporation ${corporationID}`), ticker: String(record.tickerName || record.ticker || "") };
  } catch {
    return { name: `Corporation ${corporationID}`, ticker: "" };
  }
}

// Dashboard: every grievance, newest first, plus the bots' security status.
function getOverview() {
  const now = Date.now();
  const rows = Object.values(load().pairs).map((record) => {
    const recent = recentIncidents(record, now);
    const war = unfinishedWarBetween(record.victimCorporationID, record.aggressorCorporationID);
    return {
      victim: { corporationID: record.victimCorporationID, ...corporationName(record.victimCorporationID) },
      aggressor: { corporationID: record.aggressorCorporationID, ...corporationName(record.aggressorCorporationID) },
      incidentsToday: recent.length,
      total: Number(record.total) || 0,
      byPerson: record.byPerson === true,
      hostile: isHostileCorporation(record.victimCorporationID, record.aggressorCorporationID, now),
      hostileUntil: Number(record.hostileUntilMs) > now ? new Date(record.hostileUntilMs).toISOString() : "",
      manual: record.manual || "",
      atWar: Boolean(war),
      warID: positive(war && war.warID) || positive(record.warID),
      lastAt: record.lastAtMs ? new Date(record.lastAtMs).toISOString() : "",
    };
  }).sort((left, right) => (Date.parse(right.lastAt) || 0) - (Date.parse(left.lastAt) || 0));
  const security = [];
  try {
    for (const bot of deps.playerBots().listBots()) {
      const record = deps.characters().getCharacterRecord(positive(bot.characterID)) || {};
      const value = Number(record.securityStatus ?? record.securityRating ?? 0);
      if (value < -0.5 || value > 0.5) security.push({ characterID: positive(bot.characterID), name: String(bot.characterName || ""), securityStatus: Math.round(value * 100) / 100 });
    }
  } catch { /* no roster yet */ }
  security.sort((left, right) => left.securityStatus - right.securityStatus);
  return {
    rules: { hostileAfter: HOSTILE_AFTER, warAfter: WAR_AFTER, windowHours: WINDOW_MS / 3_600_000, hostileDays: HOSTILE_FOR_MS / 86_400_000 },
    grievances: rows,
    outlaws: security.filter((entry) => entry.securityStatus < 0).slice(0, 50),
    paragons: security.filter((entry) => entry.securityStatus > 0).reverse().slice(0, 20),
  };
}

// Dashboard: mark a corporation hostile, declare war on it, or forgive it.
function runCommand(body = {}) {
  const victim = positive(body.corporationID);
  const aggressor = positive(body.targetCorporationID);
  const action = String(body.action || "").toLowerCase();
  if (!victim || !aggressor || victim === aggressor) return { success: false, message: "Choose a bot corporation and another corporation." };
  if (!["hostile", "war", "clear", "reset"].includes(action)) return { success: false, message: "Action must be hostile, war, clear or reset." };
  if (aggressor < PLAYER_CORPORATION_MIN_ID) return { success: false, message: "NPC corporations cannot be marked or fought." };
  const data = load();
  const key = pairKey(victim, aggressor);
  if (action === "reset") {
    delete data.pairs[key];
    save();
    return { success: true, message: "Grievance removed; the bots treat that corporation as neutral again." };
  }
  const record = data.pairs[key] || { victimCorporationID: victim, aggressorCorporationID: aggressor, total: 0, incidents: [], hostileUntilMs: 0, manual: "", warID: 0, byPerson: false };
  record.manual = action;
  if (action === "clear") record.hostileUntilMs = 0;
  data.pairs[key] = record;
  if (action === "war") data.lastWarAttemptAtMs = 0;
  save();
  return {
    success: true,
    message: action === "hostile" ? "Marked hostile: gate campers in low and null security space will engage its pilots."
      : action === "war" ? "The corporation will declare war at its next chance (it needs a structure as war headquarters and 200M ISK)."
        : "Forgiven: no more hostility or war from these incidents.",
  };
}

module.exports = {
  HOSTILE_AFTER,
  WAR_AFTER,
  declareGrievanceWars,
  getOverview,
  hasActiveHostiles,
  isHostileCharacter,
  isHostileCorporation,
  recordAggression,
  runCommand,
  _testing: {
    deps,
    reset() { state = null; lastIncidentByKey.clear(); },
  },
};
