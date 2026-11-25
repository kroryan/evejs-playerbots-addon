"use strict";

// Home base: like players in a corporation, bots live and work around their
// headquarters: the corporation's Upwell headquarters structure, the one the
// bots build, fuel and prioritise. In order:
//   1. a structure chosen with "/bots corp hq set";
//   2. the corporation's own structure marked as its headquarters;
//   3. an NPC station chosen with "/bots corp hq set", for a corporation
//      with no headquarters structure.
// A corporation with none of these has no home and its pilots roam as before.
// A bot that finishes a job further than the home range from its
// headquarters flies home before taking the next one, so the searches for
// belts, anomalies, planets and agents start from home. Mining is based at
// the headquarters itself, or at the nearest station with belts. A range of 0
// turns all of this off.

const HOME_CACHE_MS = 60_000;
const ROUTE_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_RANGE_JUMPS = 5;
// Traders follow the markets; everyone else comes home.
const ROAMING_SPECIALTIES = new Set(["trade"]);

const homeCache = new Map(); // corporationID -> { at, home }
const routeCache = new Map(); // "from:to" -> { at, hops }

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
  structures: lazy("../structure/structureState"),
  worldData: lazy("../../space/worldData"),
  corpCommands: lazy("./playerBotCorpCommands"),
  space: lazy("./playerBotSpaceRuntime"),
  operations: lazy("./playerBotOperationRuntime"),
  configuration: lazy("./playerBotConfigurationRuntime"),
};

function homeRangeJumps() {
  try {
    const value = Number(deps.configuration().getSettings().homeRangeJumps);
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : DEFAULT_RANGE_JUMPS;
  } catch {
    return DEFAULT_RANGE_JUMPS;
  }
}

function describeStation(stationID, source) {
  const world = deps.worldData();
  const station = world.getStationByID(stationID);
  if (station) {
    return {
      stationID,
      systemID: positive(station.solarSystemID),
      kind: "station",
      name: String(station.stationName || station.itemName || ""),
      source,
    };
  }
  let structure = null;
  try { structure = deps.structures().getStructureByID(stationID, { refresh: false }); } catch { structure = null; }
  if (!structure && typeof world.getStructureByID === "function") structure = world.getStructureByID(stationID);
  if (!structure || structure.destroyedAt || structure.unanchoring) return null;
  return {
    stationID,
    systemID: positive(structure.solarSystemID),
    kind: "structure",
    name: String(structure.itemName || structure.name || ""),
    hasQuantumCore: structure.hasQuantumCore === true,
    source,
  };
}

function markedHeadquarters(corporationID) {
  let owned = [];
  try { owned = deps.structures().listOwnedStructures(corporationID, { refresh: false }) || []; } catch { owned = []; }
  const structure = owned.find((entry) => entry && !entry.destroyedAt && !entry.unanchoring &&
    entry.devFlags && entry.devFlags.playerBotCorporationHeadquarters === true &&
    positive(entry.devFlags.playerBotHeadquartersCorporationID) === corporationID);
  if (!structure) return null;
  try {
    if (!deps.structures().isDockingServiceOnline(structure)) return null;
  } catch { /* treat as usable */ }
  return describeStation(positive(structure.structureID || structure.itemID), "structure");
}

function savedHeadquarters(corporationID) {
  const commands = deps.corpCommands();
  const savedID = typeof commands.getSavedHeadquartersID === "function" ? positive(commands.getSavedHeadquartersID(corporationID)) : 0;
  if (!savedID) return null;
  const saved = commands.getHeadquarters(corporationID);
  if (!saved || saved.error) return null;
  const described = describeStation(positive(saved.stationID), "saved");
  return described && described.systemID ? described : null;
}

// The Upwell headquarters structure comes first; an NPC station saved as the
// HQ is only home for a corporation without one.
function resolveHome(corporationID) {
  const saved = savedHeadquarters(corporationID);
  if (saved && saved.kind === "structure") return saved;
  const marked = markedHeadquarters(corporationID);
  if (marked && marked.systemID) return marked;
  return saved;
}

// The headquarters bots of this corporation call home, or null.
function getHomeBase(corporationID) {
  const id = positive(corporationID);
  if (!id) return null;
  const cached = homeCache.get(id);
  if (cached && Date.now() - cached.at < HOME_CACHE_MS) return cached.home;
  let home = null;
  try { home = resolveHome(id); } catch { home = null; }
  homeCache.set(id, { at: Date.now(), home });
  return home;
}

function corporationOf(bot) {
  const character = deps.characters().getCharacterRecord(positive(bot && bot.characterID)) || {};
  return positive(character.corporationID || bot && bot.corporationID);
}

function homeFor(bot) {
  if (homeRangeJumps() <= 0) return null;
  return getHomeBase(corporationOf(bot));
}

function jumpsBetween(fromSystemID, toSystemID) {
  const from = positive(fromSystemID);
  const to = positive(toSystemID);
  if (!from || !to) return Infinity;
  if (from === to) return 0;
  const key = `${from}:${to}`;
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) return cached.hops;
  let hops = Infinity;
  try {
    const route = deps.space().findStargateRoute(from, to);
    if (route && route.success) hops = Array.isArray(route.gates) ? route.gates.length : Infinity;
  } catch { hops = Infinity; }
  if (routeCache.size > 20_000) routeCache.clear();
  routeCache.set(key, { at: Date.now(), hops });
  return hops;
}

// How far a bot is from home: { home, hops, range } or null without a home.
function distanceFromHome(bot) {
  const home = homeFor(bot);
  if (!home) return null;
  const character = deps.characters().getCharacterRecord(positive(bot && bot.characterID)) || {};
  return { home, hops: jumpsBetween(character.solarSystemID, home.systemID), range: homeRangeJumps() };
}

// A docked bot with no job, further from home than the range, flies home.
// Returns the relocation assignment, or null.
function chooseReturnHome(bot) {
  if (!bot || ROAMING_SPECIALTIES.has(String(bot.specialty || "").toLowerCase())) return null;
  const distance = distanceFromHome(bot);
  if (!distance || !Number.isFinite(distance.hops) || distance.hops <= distance.range) return null;
  const character = deps.characters().getCharacterRecord(positive(bot.characterID)) || {};
  if (!positive(character.stationID || character.structureID)) return null;
  if (positive(character.stationID || character.structureID) === distance.home.stationID) return null;
  return { kind: "relocate", stationID: distance.home.stationID, home: true, hops: distance.hops };
}

// Where a bot's mining trips are based: the headquarters when it can be a
// mining home, else the nearest high-security station with belts in range of
// it. 0 when the bot has no home or none is in range.
function homeMiningStation(bot) {
  const home = homeFor(bot);
  if (!home) return 0;
  const world = deps.worldData();
  const system = world.getSolarSystemByID(home.systemID) || {};
  const hasBelts = (world.getAsteroidBeltsForSystem(home.systemID) || []).length > 0;
  const structureOk = home.kind !== "structure" || home.hasQuantumCore === true;
  const floor = minWorkSecurity();
  if (hasBelts && Number(system.security) >= floor && structureOk) return home.stationID;
  try {
    const jita = require("./playerBotEconomyRuntime").JITA_SYSTEM_ID;
    const nearest = deps.operations().findNearestMiningStation(home.systemID, floor, homeRangeJumps(), [jita]);
    return nearest ? positive(nearest.stationID) : 0;
  } catch {
    return 0;
  }
}

// The lowest system security pilots work in: the "fear" setting. 0 keeps
// them in high-sec (0.45), 1 lets them into low-sec, 2 into null-sec.
function minWorkSecurity() {
  try {
    const tolerance = Math.trunc(Number(deps.configuration().getSettings().riskTolerance));
    return tolerance >= 2 ? -1 : tolerance === 1 ? 0.1 : 0.45;
  } catch {
    return 0.45;
  }
}

// Where a security pilot camps its home system: one of the HQ system's
// stargates (spread across pilots), docking at an NPC station in the system
// or the HQ itself. { success, stationID, systemID, patrolEntityID, ... }.
function gateCampBase(bot) {
  const home = getHomeBase(corporationOf(bot));
  if (!home) return { success: false, message: "The corporation has no headquarters to defend." };
  const world = deps.worldData();
  const gates = (world.getStargatesForSystem(home.systemID) || [])
    .map((gate) => positive(gate.itemID || gate.stargateID)).filter(Boolean).sort((left, right) => left - right);
  if (!gates.length) return { success: false, message: "The headquarters system has no stargates to camp." };
  const npcStation = (world.getStationsForSystem(home.systemID) || [])
    .map((station) => positive(station.stationID || station.itemID)).filter(Boolean).sort((left, right) => left - right)[0];
  return {
    success: true,
    mode: "gate-camp",
    stationID: npcStation || home.stationID,
    systemID: home.systemID,
    patrolEntityID: gates[positive(bot && bot.characterID) % gates.length],
    hops: 0,
    risk: null,
  };
}

// The system a bot's searches for work should start from: home.
function searchOriginSystemID(bot) {
  const home = homeFor(bot);
  return home ? home.systemID : 0;
}

module.exports = {
  DEFAULT_RANGE_JUMPS,
  chooseReturnHome,
  distanceFromHome,
  getHomeBase,
  homeMiningStation,
  gateCampBase,
  homeRangeJumps,
  jumpsBetween,
  minWorkSecurity,
  searchOriginSystemID,
  _testing: {
    deps,
    jumpsBetween,
    reset() {
      homeCache.clear();
      routeCache.clear();
    },
  },
};
