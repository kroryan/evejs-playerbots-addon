"use strict";

// Intelligence for the Territory Map's empire dashboard: trade routes, mining
// and combat activity, kills, wars and structures across New Eden, plus a
// report for one corporation (its pilots, structures, territory, wars and
// threats near its space). Also sends a corporation's bots to mine or defend
// a system the operator picks.

const GLOBAL_CACHE_MS = 15_000;
const DISPATCH_RETRY_MS = 3_000;
const DISPATCH_TIMEOUT_MS = 2 * 60_000;
const MAX_DISPATCH = 20;
const ROUTE_KINDS = { sell: "Selling", haul: "Hauling", "trade-run": "Trade run",
  "alliance-courier": "Alliance courier", "structure-procurement": "Structure delivery" };

let globalCache = null;
let globalCacheAtMs = 0;
const pendingDispatch = new Map(); // characterID -> { action, systemID, stationID, untilMs, corporationID }
let dispatchTimer = null;

const positiveID = (value) => {
  const id = Math.trunc(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};
const filetimeToMs = (value) => {
  try {
    const ticks = BigInt(String(value || 0));
    return ticks > 116444736000000000n ? Number((ticks - 116444736000000000n) / 10_000n) : 0;
  } catch (_) { return 0; }
};

function names() {
  const corporations = new Map();
  const alliances = new Map();
  const state = require("../corporation/corporationState");
  return {
    corp(id) {
      id = positiveID(id);
      if (!id) return 0;
      if (!corporations.has(id)) {
        let name = "";
        try { name = state.getCorporationRecord(id)?.corporationName || ""; } catch (_) { name = ""; }
        corporations.set(id, name || `Corporation ${id}`);
      }
      return id;
    },
    alliance(id) {
      id = positiveID(id);
      if (!id) return 0;
      if (!alliances.has(id)) {
        let name = "";
        try { name = state.getAllianceRecord(id)?.allianceName || ""; } catch (_) { name = ""; }
        alliances.set(id, name || `Alliance ${id}`);
      }
      return id;
    },
    export: () => ({ corporations: Object.fromEntries(corporations), alliances: Object.fromEntries(alliances) }),
  };
}

function structureIndex() {
  const structureState = require("../structure/structureState");
  const rows = typeof structureState.peekStructures === "function" ? structureState.peekStructures() : structureState.listStructures();
  return rows.filter((entry) => entry && !entry.destroyedAt);
}

function locationSystem(locationID, structuresByID) {
  const id = positiveID(locationID);
  if (!id) return 0;
  const structure = structuresByID.get(id);
  if (structure) return positiveID(structure.solarSystemID);
  try { return positiveID(require("../../space/worldData").getStationByID(id)?.solarSystemID); } catch (_) { return 0; }
}

function routeEnds(operation, structuresByID) {
  const pairs = {
    sell: ["originStationID", "marketStationID"],
    haul: ["fromStationID", "toStationID"],
    "trade-run": ["sourceStationID", "hubStationID"],
    "alliance-courier": ["startStationID", "endStationID"],
    "structure-procurement": ["marketStationID", null],
  }[operation.kind];
  if (!pairs) return null;
  const from = locationSystem(operation[pairs[0]], structuresByID);
  const to = pairs[1] ? locationSystem(operation[pairs[1]], structuresByID) : positiveID(operation.destinationSystemID);
  return from && to && from !== to ? [from, to] : null;
}

function typeName(typeID) {
  try { return require("../inventory/itemTypeRegistry").resolveItemByTypeID(positiveID(typeID))?.name || ""; } catch (_) { return ""; }
}

function unfinishedWars() {
  const now = Date.now();
  return require("../corporation/warRuntimeState").listAllWars().filter((war) => {
    if (!war.timeFinished) return true;
    return filetimeToMs(war.timeFinished) > now;
  });
}

// Everything that does not depend on the chosen corporation. Cached briefly.
function buildGlobal() {
  const now = Date.now();
  if (globalCache && now - globalCacheAtMs < GLOBAL_CACHE_MS) return globalCache;
  const n = names();
  const { readSharedCharacterRecord } = require("../character/characterState");
  const structures = structureIndex();
  const structuresByID = new Map(structures.map((entry) => [positiveID(entry.structureID || entry.itemID), entry]));

  // Bots: where they are and what they do.
  const operations = require("./playerBotOperationRuntime").listActiveOperationRecords();
  const routes = new Map();
  const mining = {};
  const combat = {};
  const activity = {};
  const activityBySystem = {}; // systemID -> { kind: count }
  const ops = [];
  for (const operation of operations) {
    const character = readSharedCharacterRecord(operation.characterID) || {};
    const here = positiveID(character.solarSystemID);
    const corporationID = positiveID(operation.corporationID || character.corporationID);
    activity[operation.kind] = (activity[operation.kind] || 0) + 1;
    let systemID = 0;
    const ends = routeEnds(operation, structuresByID);
    if (ends) {
      const key = `${ends[0]}:${ends[1]}`;
      const entry = routes.get(key) || { from: ends[0], to: ends[1], count: 0, kinds: {}, corporations: new Map() };
      entry.count += 1;
      entry.kinds[operation.kind] = (entry.kinds[operation.kind] || 0) + 1;
      entry.corporations.set(corporationID, (entry.corporations.get(corporationID) || 0) + 1);
      routes.set(key, entry);
    } else if (operation.kind === "mine") {
      systemID = locationSystem(operation.homeStationID, structuresByID) || here;
      if (systemID) mining[systemID] = (mining[systemID] || 0) + 1;
    } else if (operation.kind === "combat") {
      systemID = positiveID(operation.targetSystemID) || locationSystem(operation.homeStationID, structuresByID) || here;
      if (systemID) combat[systemID] = (combat[systemID] || 0) + 1;
    }
    const at = systemID || here;
    if (at && !ends) (activityBySystem[at] ||= {})[operation.kind] = (activityBySystem[at][operation.kind] || 0) + 1;
    ops.push([corporationID, operation.kind, at, ends]);
  }
  const routeList = [...routes.values()].sort((a, b) => b.count - a.count).slice(0, 400).map((entry) => {
    const [topCorp] = [...entry.corporations].sort((a, b) => b[1] - a[1])[0] || [0];
    const [topKind] = Object.entries(entry.kinds).sort((a, b) => b[1] - a[1])[0] || ["haul"];
    return [entry.from, entry.to, entry.count, topKind, n.corp(topCorp), routePath(entry.from, entry.to)];
  });

  // Kills in the last 24 hours (newest first; stop at the cutoff).
  const kills = {};
  const recentKills = [];
  const dayAgo = now - 24 * 60 * 60 * 1000;
  try {
    require("../killmail/killmailState").forEachKillmailRecordDescending((record) => {
      const at = filetimeToMs(record.killTime);
      if (at && at < dayAgo) return false;
      const systemID = positiveID(record.solarSystemID);
      if (systemID) {
        const entry = kills[systemID] || (kills[systemID] = [0, 0]);
        entry[0] += 1;
        if (at >= now - 60 * 60 * 1000) entry[1] += 1;
      }
      if (recentKills.length < 60) {
        recentKills.push([at, systemID, n.corp(record.victimCorporationID), positiveID(record.victimShipTypeID),
          n.corp(record.finalCorporationID), positiveID(record.victimCharacterID), positiveID(record.finalCharacterID)]);
      }
      return true;
    });
  } catch (_) { /* killmails unavailable */ }
  const shipNames = {};
  for (const kill of recentKills) if (kill[3] && !shipNames[kill[3]]) shipNames[kill[3]] = typeName(kill[3]) || `Type ${kill[3]}`;

  // Wars that have not finished.
  const owner = (id) => {
    try {
      if (require("../corporation/corporationState").getCorporationRecord(id)) return ["c", n.corp(id)];
    } catch (_) { /* fall through */ }
    return ["a", n.alliance(id)];
  };
  const wars = unfinishedWars().map((war) => {
    const [aKind] = owner(Number(war.declaredByID));
    const [bKind] = owner(Number(war.againstID));
    return [positiveID(war.warID), Number(war.declaredByID), aKind, Number(war.againstID), bKind,
      filetimeToMs(war.timeStarted || war.timeDeclared), Boolean(war.mutual)];
  });

  // Structures by system.
  const structureTypes = {};
  const structuresBySystem = {};
  for (const structure of structures) {
    const systemID = positiveID(structure.solarSystemID);
    const typeID = positiveID(structure.typeID);
    if (!systemID || !typeID) continue;
    if (!structureTypes[typeID]) {
      let type = null;
      try { type = require("../structure/structureState").getStructureTypeByID(typeID); } catch (_) { type = null; }
      structureTypes[typeID] = String(type?.name || typeName(typeID) || `Structure ${typeID}`);
    }
    (structuresBySystem[systemID] ||= []).push([positiveID(structure.structureID || structure.itemID), typeID,
      n.corp(structure.ownerCorpID || structure.ownerID), Number(structure.state) || 0, String(structure.itemName || structure.name || "")]);
  }

  globalCache = {
    at: new Date(now).toISOString(),
    routes: routeList,
    routeKinds: ROUTE_KINDS,
    mining,
    combat,
    activity,
    // The main job in each system with bot work: [kind, pilots there working].
    activityBySystem: Object.fromEntries(Object.entries(activityBySystem).map(([id, kinds]) => {
      const [kind] = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
      return [id, [kind, Object.values(kinds).reduce((sum, n) => sum + n, 0)]];
    })),
    kills,
    recentKills,
    shipNames,
    wars,
    structures: structuresBySystem,
    structureTypes,
    _ops: ops,
    _names: n,
  };
  globalCacheAtMs = now;
  return globalCache;
}

function onlinePlayers() {
  const out = [];
  const { readSharedCharacterRecord } = require("../character/characterState");
  try {
    for (const session of require("../chat/sessionRegistry").getSessions()) {
      if (!session || session._playerBotActor) continue;
      const characterID = positiveID(session.characterID || session.charID || session.charid);
      if (!characterID) continue;
      const character = readSharedCharacterRecord(characterID) || {};
      out.push([characterID, String(character.characterName || characterID), positiveID(character.corporationID),
        positiveID(character.solarSystemID), positiveID(session.shipTypeID || character.shipTypeID)]);
    }
  } catch (_) { /* sessions unavailable */ }
  return out;
}

function neighbourMap() {
  const adjacency = new Map();
  for (const [a, b] of require("./playerBotMapApiRuntime").buildStaticMap().links || []) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  return adjacency;
}
let adjacencyCache = null;

function buildCorporation(global, corporationID, players) {
  const n = global._names;
  const state = require("../corporation/corporationState");
  const record = state.getCorporationRecord(corporationID);
  if (!record) return null;
  n.corp(corporationID);
  const allianceID = n.alliance(record.allianceID);
  const territory = require("./playerBotTerritoryClaimsRuntime");
  const claims = territory.getClaims()[corporationID] || [];
  const anchors = territory.anchorSystems(corporationID);
  const owned = territory.ownedSystems(corporationID);

  // Pilots: bots in the corporation, and online players.
  const { readSharedCharacterRecord } = require("../character/characterState");
  const bots = [];
  for (const profile of require("./playerBotRuntime").listBotProfiles()) {
    const character = readSharedCharacterRecord(Number(profile.characterID)) || {};
    if (positiveID(character.corporationID ?? profile.corporationID) !== corporationID) continue;
    bots.push(Number(profile.characterID));
  }
  const botSet = new Set(bots);
  const activity = {};
  const myRoutes = new Map();
  const myMining = {};
  for (const [opCorp, kind, systemID, ends] of global._ops) {
    if (opCorp !== corporationID) continue;
    activity[kind] = (activity[kind] || 0) + 1;
    if (ends) {
      const key = `${ends[0]}:${ends[1]}`;
      myRoutes.set(key, [ends[0], ends[1], (myRoutes.get(key)?.[2] || 0) + 1, kind, routePath(ends[0], ends[1])]);
    } else if (kind === "mine" && systemID) myMining[systemID] = (myMining[systemID] || 0) + 1;
  }
  const members = players.filter((player) => player[2] === corporationID);

  // Structures it owns.
  const structures = [];
  for (const [systemID, list] of Object.entries(global.structures)) {
    for (const entry of list) if (entry[2] === corporationID) structures.push([entry[0], entry[1], Number(systemID), entry[3], entry[4]]);
  }

  // Wars involving it or its alliance.
  const owners = new Set([corporationID, allianceID].filter(Boolean));
  const wars = global.wars.filter((war) => owners.has(war[1]) || owners.has(war[3]));
  const enemies = new Set(wars.map((war) => (owners.has(war[1]) ? war[3] : war[1])));

  // Threats: war targets and recent kills in or next to its space.
  if (!adjacencyCache) adjacencyCache = neighbourMap();
  const home = new Set([...claims, ...anchors, ...owned, ...structures.map((s) => s[2]), ...members.map((m) => m[3])].filter(Boolean));
  const watched = new Map();
  for (const systemID of home) {
    watched.set(systemID, "home");
    for (const next of adjacencyCache.get(systemID) || []) if (!watched.has(next)) watched.set(next, "adjacent");
  }
  const hostiles = new Map(); // systemID -> [count, sample corpID]
  if (enemies.size) {
    const isEnemy = (characterCorpID) => {
      if (enemies.has(characterCorpID)) return true;
      try { return enemies.has(positiveID(state.getCorporationRecord(characterCorpID)?.allianceID)); } catch (_) { return false; }
    };
    const corpEnemy = new Map();
    const check = (corpID) => {
      if (!corpEnemy.has(corpID)) corpEnemy.set(corpID, isEnemy(corpID));
      return corpEnemy.get(corpID);
    };
    for (const profile of require("./playerBotRuntime").listBotProfiles()) {
      const character = readSharedCharacterRecord(Number(profile.characterID)) || {};
      const systemID = positiveID(character.solarSystemID);
      if (!watched.has(systemID)) continue;
      const corpID = positiveID(character.corporationID ?? profile.corporationID);
      if (!corpID || !check(corpID)) continue;
      const entry = hostiles.get(systemID) || [0, n.corp(corpID)];
      entry[0] += 1;
      hostiles.set(systemID, entry);
    }
    for (const player of players) {
      if (!watched.has(player[3]) || !player[2] || !check(player[2])) continue;
      const entry = hostiles.get(player[3]) || [0, n.corp(player[2])];
      entry[0] += 1;
      hostiles.set(player[3], entry);
    }
  }
  const threats = [];
  for (const [systemID, where] of watched) {
    const hostile = hostiles.get(systemID);
    const kills = global.kills[systemID] || [0, 0];
    const contested = (territory.getContested()[systemID] || []).includes(corporationID);
    if (!hostile && !kills[1] && !contested) continue;
    const level = (hostile ? 2 : 0) + (kills[1] ? 1 : 0) + (contested ? 1 : 0) + (where === "home" ? 1 : 0);
    threats.push([systemID, where, hostile ? hostile[0] : 0, hostile ? hostile[1] : 0, kills[1], contested ? 1 : 0, level]);
  }
  threats.sort((a, b) => b[6] - a[6] || b[2] - a[2] || a[0] - b[0]);

  return {
    corporationID,
    name: record.corporationName || `Corporation ${corporationID}`,
    ticker: String(record.tickerName || record.ticker || ""),
    allianceID,
    memberCount: Math.max(bots.length, (() => {
      try { return (state.getCharacterIDsInCorporation(corporationID) || []).length; } catch (_) { return 0; }
    })()),
    botCount: bots.length,
    botRun: botSet.has(Number(record.ceoID)),
    online: members,
    activity,
    routes: [...myRoutes.values()],
    mining: myMining,
    structures,
    claims,
    anchors,
    owned,
    wars: wars.map((war) => war[0]),
    threats: threats.slice(0, 40),
    pendingDispatch: [...pendingDispatch.values()].filter((entry) => entry.corporationID === corporationID).length,
  };
}

// The systems a bot flies through between two systems: the same stargate
// route its navigation plans (cached by the pathfinder), so the map can draw
// the real path rather than a straight line.
function routePath(fromSystemID, toSystemID) {
  try {
    const route = require("./playerBotSpaceRuntime").findStargateRoute(fromSystemID, toSystemID);
    return route && route.success && Array.isArray(route.systemIDs) ? route.systemIDs.map(Number) : [fromSystemID, toSystemID];
  } catch (_) {
    return [fromSystemID, toSystemID];
  }
}

function buildIntel(corporationIDValue) {
  const global = buildGlobal();
  const players = onlinePlayers();
  const n = global._names;
  for (const player of players) n.corp(player[2]);
  const corporationID = positiveID(corporationIDValue);
  const corporation = corporationID ? buildCorporation(global, corporationID, players) : null;
  // The operator's corporation is usually the one an online player is in.
  const suggested = (players.find((player) => player[2] && !require("../corporation/corporationState").isNpcCorporationID?.(player[2])) || [])[2] || 0;
  const { _ops, _names, ...rest } = global;
  return { ...rest, ...n.export(), players, suggestedCorporationID: suggested || 0, corporation };
}

// ------------------------------------------------------------ dispatch

function baseInSystem(systemID, corporationID, needBelts) {
  const worldData = require("../../space/worldData");
  if (needBelts && !(worldData.getAsteroidBeltsForSystem(systemID) || []).length) return { error: "The system has no asteroid belts." };
  const station = (worldData.getStationsForSystem(systemID) || [])
    .map((entry) => positiveID(entry.stationID || entry.itemID)).filter(Boolean).sort((a, b) => a - b)[0];
  if (station) return { stationID: station };
  let type = null;
  const structure = structureIndex().find((entry) => positiveID(entry.solarSystemID) === systemID &&
    positiveID(entry.ownerCorpID || entry.ownerID) === corporationID && !entry.unanchoring && Number(entry.state) >= 100 &&
    (type = require("../structure/structureState").getStructureTypeByID(positiveID(entry.typeID))) && type.dockable);
  if (structure) return { stationID: positiveID(structure.structureID || structure.itemID) };
  return { error: "The system has no NPC station and no Upwell station of the corporation to work from." };
}

// Operations resolve pilots by name. "Defend" alternates gate campers (on the
// system's stargates) and belt and anomaly patrols.
function startDispatch(entry) {
  const operations = require("./playerBotOperationRuntime");
  if (entry.action === "mine") return operations.startMining(entry.characterName, 3, { stationID: entry.stationID });
  const options = { patrolSystemID: entry.systemID, patrolStationID: entry.stationID };
  if (entry.role === "gate-camp") {
    const camp = operations.startCombat(entry.characterName, "gate-camp", options);
    if (camp && camp.success) return camp;
  }
  return operations.startCombat(entry.characterName, "security", options);
}

function retryDispatch() {
  const now = Date.now();
  const operations = require("./playerBotOperationRuntime");
  for (const [characterID, entry] of pendingDispatch) {
    if (now > entry.untilMs) { pendingDispatch.delete(characterID); continue; }
    if (operations.hasActiveOperation(characterID)) continue;
    try {
      const result = startDispatch(entry);
      if (result && result.success) pendingDispatch.delete(characterID);
    } catch (_) { /* try again */ }
  }
  if (!pendingDispatch.size && dispatchTimer) { clearInterval(dispatchTimer); dispatchTimer = null; }
}

function commandBots(corporationIDValue, systemIDValue, actionValue, countValue) {
  const corporationID = positiveID(corporationIDValue);
  const systemID = positiveID(systemIDValue);
  const action = String(actionValue || "");
  const count = Math.min(MAX_DISPATCH, Math.max(1, Math.trunc(Number(countValue)) || 5));
  if (!corporationID || !systemID) return { success: false, statusCode: 400, message: "A corporation and a system are required." };
  if (!["mine", "defend"].includes(action)) return { success: false, statusCode: 400, message: "Action must be mine or defend." };
  const base = baseInSystem(systemID, corporationID, action === "mine");
  if (base.error) return { success: false, statusCode: 409, message: base.error };

  const playerBots = require("./playerBotRuntime");
  const operations = require("./playerBotOperationRuntime");
  const { readSharedCharacterRecord } = require("../character/characterState");
  let controlled = new Set();
  try { controlled = new Set([...require("./playerBotCapacityRuntime").getHumanControlledBotIDs()].map(Number)); } catch (_) { controlled = new Set(); }
  const wantedSpecialty = action === "mine" ? "mining" : "security";
  const keep = new Set(["combat", "structure-procurement", "structure-deployment", "structure-core-install",
    "structure-service-provision", "sovereignty", "alliance-founding", "colony"]);
  const candidates = [];
  for (const bot of playerBots.listBots()) {
    const characterID = Number(bot.characterID);
    if (pendingDispatch.has(characterID) || controlled.has(characterID)) continue;
    if (bot.status === "paused" || bot.autonomyPaused === true) continue;
    const character = readSharedCharacterRecord(characterID) || {};
    if (positiveID(character.corporationID ?? bot.corporationID) !== corporationID) continue;
    const current = operations.getOperation(characterID);
    const busy = Boolean(current && ["active", "holding", "review"].includes(current.status));
    if (busy && keep.has(current.kind) && !(action === "mine" && current.kind === "combat")) continue;
    const score = (busy ? 0 : 4) + (bot.specialty === wantedSpecialty ? 2 : 0) +
      (positiveID(character.solarSystemID) === systemID ? 1 : 0);
    candidates.push({ bot, characterID, busy, score });
  }
  if (!candidates.length) return { success: false, statusCode: 409, message: "The corporation has no available bots for this order." };
  candidates.sort((a, b) => b.score - a.score || a.characterID - b.characterID);
  let started = 0;
  let switching = 0;
  const errors = [];
  let picked = 0;
  const entryFor = (candidate) => ({ action, systemID, stationID: base.stationID, corporationID,
    role: action === "defend" && (picked++ % 2 === 0) ? "gate-camp" : "patrol",
    untilMs: Date.now() + DISPATCH_TIMEOUT_MS, characterID: candidate.characterID, characterName: candidate.bot.characterName });
  for (const candidate of candidates) {
    if (started + switching >= count) break;
    if (candidate.busy) {
      try { operations.stopOperation(candidate.bot.characterName); } catch (_) { continue; }
      pendingDispatch.set(candidate.characterID, entryFor(candidate));
      switching += 1;
      continue;
    }
    try {
      const result = startDispatch(entryFor(candidate));
      if (result && result.success) started += 1;
      else if (errors.length < 3) errors.push(`${candidate.bot.characterName}: ${String(result && result.message || "refused").slice(0, 120)}`);
    } catch (error) {
      if (errors.length < 3) errors.push(`${candidate.bot.characterName}: ${String(error.message).slice(0, 120)}`);
    }
  }
  if (switching && !dispatchTimer) {
    dispatchTimer = setInterval(retryDispatch, DISPATCH_RETRY_MS);
    if (typeof dispatchTimer.unref === "function") dispatchTimer.unref();
  }
  globalCache = null;
  const verb = action === "mine" ? "mining" : "gate camping and patrolling";
  const parts = [];
  if (started) parts.push(`${started} pilot${started === 1 ? "" : "s"} now ${verb}`);
  if (switching) parts.push(`${switching} finishing their current job first`);
  return {
    success: started + switching > 0,
    statusCode: started + switching > 0 ? 200 : 409,
    started,
    switching,
    message: parts.length ? `${parts.join("; ")}.` : `No pilot could start. ${errors.join(" ")}`.trim(),
  };
}

module.exports = { buildIntel, commandBots, _testing: { routeEnds, routePath, baseInSystem, reset: () => { globalCache = null; adjacencyCache = null; pendingDispatch.clear(); } } };
