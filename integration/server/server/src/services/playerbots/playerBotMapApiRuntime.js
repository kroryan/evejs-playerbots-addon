"use strict";

// Read-only map data for the Territory Map add-on, served on the Playerbots
// private API: the static starmap (systems, positions, stargate links) and the
// live layer (bots in each system, sovereignty).

const worldData = require("../../space/worldData");

let staticMap = null;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function systemID(system) {
  return Math.trunc(num(system && (system.solarSystemID ?? system.itemID ?? system.id)));
}

function gateDestination(gate) {
  return Math.trunc(num(gate && (gate.destinationSolarSystemID ?? gate.destinationSystemID ??
    gate.destination?.solarSystemID ?? gate.destinationID)));
}

function readRegionNames() {
  try {
    const { TABLE, readStaticRows } = require("../_shared/referenceData");
    const names = {};
    for (const table of [TABLE.REGIONS, TABLE.CONSTELLATIONS].filter(Boolean)) {
      for (const row of readStaticRows(table) || []) {
        const id = Math.trunc(num(row.regionID ?? row.constellationID ?? row.itemID ?? row.id));
        const name = row.regionName ?? row.constellationName ?? row.itemName ?? row.name;
        if (id && name) names[id] = String(name);
      }
    }
    return names;
  } catch (_) {
    return {};
  }
}

// Systems as [id, name, x, y, z, security, regionID, constellationID] and
// stargate links as [fromID, toID] with fromID < toID. Built once.
function buildStaticMap() {
  if (staticMap) return staticMap;
  const systems = [];
  const links = new Set();
  for (const system of worldData.getSolarSystems()) {
    const id = systemID(system);
    if (!id) continue;
    const position = system.position || system;
    systems.push([
      id,
      String(system.solarSystemName ?? system.itemName ?? system.name ?? id),
      num(position.x), num(position.y), num(position.z),
      Math.round(num(system.security ?? system.securityStatus) * 100) / 100,
      Math.trunc(num(system.regionID)), Math.trunc(num(system.constellationID)),
    ]);
    for (const gate of worldData.getStargatesForSystem(id)) {
      const to = gateDestination(gate);
      if (to && to !== id) links.add(id < to ? `${id}:${to}` : `${to}:${id}`);
    }
  }
  staticMap = {
    systems,
    links: [...links].map((key) => key.split(":").map(Number)),
    names: readRegionNames(),
  };
  return staticMap;
}

function corporationName(id, cache) {
  if (!id) return "";
  if (!cache.has(id)) {
    let name = "";
    try { name = require("../corporation/corporationState").getCorporationRecord(id)?.corporationName || ""; } catch (_) { name = ""; }
    cache.set(id, name || `Corporation ${id}`);
  }
  return cache.get(id);
}

function allianceName(id, cache) {
  if (!id) return "";
  if (!cache.has(id)) {
    let name = "";
    try { name = require("../corporation/corporationState").getAllianceRecord?.(id)?.allianceName || ""; } catch (_) { name = ""; }
    cache.set(id, name || `Alliance ${id}`);
  }
  return cache.get(id);
}

// Bots by system and sovereignty by system, plus the names they refer to.
function buildLiveMap() {
  const playerBots = require("./playerBotRuntime");
  const { readSharedCharacterRecord } = require("../character/characterState");
  const bots = {};
  const corporations = new Map();
  const alliances = new Map();
  for (const profile of playerBots.listBotProfiles()) {
    const characterID = Math.trunc(num(profile.characterID));
    const character = readSharedCharacterRecord(characterID) || {};
    const id = Math.trunc(num(character.solarSystemID ?? profile.solarSystemID));
    if (!id) continue;
    const corporationID = Math.trunc(num(character.corporationID ?? profile.corporationID));
    corporationName(corporationID, corporations);
    (bots[id] ||= []).push([characterID, String(character.characterName || profile.characterName || characterID),
      corporationID, character.stationID || character.structureID ? 1 : 0]);
  }
  const sovereignty = {};
  try {
    for (const system of require("../sovereignty/sovState").listAllSovereigntySystemStates() || []) {
      const id = systemID(system);
      const allianceID = Math.trunc(num(system.allianceID));
      const corporationID = Math.trunc(num(system.corporationID));
      if (!id || (!allianceID && !corporationID)) continue;
      allianceName(allianceID, alliances);
      corporationName(corporationID, corporations);
      sovereignty[id] = [allianceID, corporationID];
    }
  } catch (_) { /* sovereignty unavailable */ }
  let claims = {};
  let contested = {};
  let territoryWars = {};
  try {
    const territory = require("./playerBotTerritoryClaimsRuntime");
    claims = territory.getClaims();
    contested = territory.getContested();
    territoryWars = territory.getTerritoryWars();
    for (const id of Object.keys(claims)) corporationName(Number(id), corporations);
  } catch (_) { /* claims unavailable */ }
  return {
    at: new Date().toISOString(),
    bots,
    sovereignty,
    claims,
    contested,
    territoryWars,
    corporations: Object.fromEntries(corporations),
    alliances: Object.fromEntries(alliances),
  };
}

// Corporations the operator can manage on the map: every corporation with a
// roster bot, online pilot or claim, with a name search for the rest.
function listMapCorporations(query = "") {
  const corporations = new Map();
  const botCounts = new Map();
  const { readSharedCharacterRecord } = require("../character/characterState");
  for (const profile of require("./playerBotRuntime").listBotProfiles()) {
    const character = readSharedCharacterRecord(Math.trunc(num(profile.characterID))) || {};
    const id = Math.trunc(num(character.corporationID ?? profile.corporationID));
    if (id) botCounts.set(id, (botCounts.get(id) || 0) + 1);
  }
  const ids = new Set(botCounts.keys());
  try {
    for (const session of require("../chat/sessionRegistry").getSessions()) {
      const id = Math.trunc(num(session && (session.corporationID || session.corpid)));
      if (id && !session._playerBotActor) ids.add(id);
    }
  } catch (_) { /* sessions unavailable */ }
  try { for (const id of Object.keys(require("./playerBotTerritoryClaimsRuntime").getClaims())) ids.add(Number(id)); } catch (_) { /* none */ }
  const text = String(query || "").trim();
  if (text) {
    try {
      const found = require("../corporation/corporationState").findCorporationByName(text);
      const id = Math.trunc(num(found && (found.corporationID || found)));
      if (id) ids.add(id);
    } catch (_) { /* not found */ }
    if (/^\d+$/.test(text)) ids.add(Number(text));
  }
  const state = require("../corporation/corporationState");
  const out = [];
  for (const id of ids) {
    if (state.isNpcCorporationID && state.isNpcCorporationID(id)) continue;
    const record = state.getCorporationRecord(id);
    if (!record) continue;
    let hq = []; // null-sec systems with its anchored Upwell stations
    try { hq = require("./playerBotTerritoryClaimsRuntime").anchorSystems(id); } catch (_) { hq = []; }
    out.push([id, String(record.corporationName || `Corporation ${id}`), botCounts.get(id) || 0, hq]);
  }
  out.sort((a, b) => a[1].localeCompare(b[1]));
  return { corporations: out };
}

module.exports = { buildStaticMap, buildLiveMap, listMapCorporations };
