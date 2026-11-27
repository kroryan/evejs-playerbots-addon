"use strict";

// World seed (optional, operator-run): gives every corporation a near-equal
// start in null-sec without simulating the travel, purchases and timers.
// Each corporation gets its own null-sec region, an Astrahus (headquarters),
// a Raitaru and an Athanor anchored, cored, fuelled and online with service
// modules, three claimed systems with sovereignty, ISK in its wallet, its bots
// docked in its structures, and a few market orders and manufacturing jobs.
// Everything is written through EveJS's own state modules so caches, indexes
// and notifications stay right. A dry run returns the plan without changes.
// Progress is saved per corporation and step, so a run can be repeated: done
// steps are skipped.

const STORE_PATH = "/_worldSeed";
const KSPACE_MAX_SYSTEM_ID = 31_000_000;
const CORP_ISK = 2_000_000_000;
const CLAIMS = 3;
const MOVE_BATCH = 8;
const BATCH_DELAY_MS = 150;
const FUEL_BLOCKS = 15_000;
const STRUCTURES = Object.freeze([
  { role: "headquarters", type: "astrahus", typeID: 35832, modules: ["Standup Market Hub I", "Standup Cloning Center I"] },
  { role: "industry", type: "raitaru", typeID: 35825, modules: ["Standup Manufacturing Plant I"] },
  { role: "refinery", type: "athanor", typeID: 35835, modules: ["Standup Reprocessing Facility I"] },
]);
const STRUCTURE_FOR_SPECIALTY = { mining: "refinery", planetary: "refinery", industry: "industry" };
const MINERALS = [["Tritanium", 150_000], ["Pyerite", 60_000], ["Mexallon", 20_000], ["Isogen", 6_000], ["Nocxium", 1_500], ["Zydrine", 600], ["Megacyte", 250]];
const ORDER_TRADERS = 2;
const JOB_BUILDERS = 2;

let state = null;
let deps = defaultDeps();

function defaultDeps() {
  return {
    repo: () => require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true }),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    log: () => require("../../utils/logger"),
  };
}

const positiveID = (value) => {
  const id = Math.trunc(Number(value));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};

function load() {
  if (state) return state;
  const stored = deps.repo().read("playerBots", STORE_PATH);
  state = (stored.success && stored.data) || { status: "idle", corporations: {} };
  if (state.status === "running") state.status = "interrupted"; // the server restarted mid-run
  return state;
}

function save() {
  const repo = deps.repo();
  repo.ensureTable("playerBots");
  repo.write("playerBots", STORE_PATH, JSON.parse(JSON.stringify({ ...state, queue: undefined })));
  repo.flushTableSync("playerBots");
}

function isRunning() {
  return Boolean(state && state.status === "running");
}

function getStatus() {
  const current = load();
  const corporations = Object.values(current.corporations || {});
  return {
    status: current.status,
    startedAt: current.startedAt || null,
    finishedAt: current.finishedAt || null,
    step: current.step || "",
    moved: current.moved || 0,
    toMove: current.toMove || 0,
    errors: (current.errors || []).slice(-20),
    corporations: corporations.map((entry) => ({
      corporationID: entry.corporationID, name: entry.name, regionName: entry.regionName,
      homeSystemID: entry.homeSystemID, claims: entry.claims, done: entry.done || {},
    })),
  };
}

// ------------------------------------------------------------ planning

function typeID(name) {
  try {
    const result = require("../inventory/itemTypeRegistry").resolveItemByName(name);
    const match = result && result.success && result.match;
    return match && String(match.name).toLowerCase() === name.toLowerCase() ? positiveID(match.typeID) : 0;
  } catch (_) { return 0; }
}

function claimable(systemID) {
  try { return Boolean(require("../sovereignty/sovSystemRules").isSovereigntyClaimableSolarSystem(systemID)); } catch (_) { return false; }
}

function corporationsToSeed(options) {
  const corporationState = require("../corporation/corporationState");
  const { readSharedCharacterRecord } = require("../character/characterState");
  const ids = new Set((options.corporationIDs || []).map(positiveID).filter(Boolean));
  const bots = require("./playerBotRuntime").listBots();
  for (const bot of bots) {
    const character = readSharedCharacterRecord(Number(bot.characterID)) || {};
    const id = positiveID(character.corporationID ?? bot.corporationID);
    if (id) ids.add(id);
  }
  try {
    for (const session of require("../chat/sessionRegistry").getSessions()) {
      if (session && !session._playerBotActor) ids.add(positiveID(session.corporationID || session.corpid));
    }
  } catch (_) { /* sessions unavailable */ }
  return [...ids].filter((id) => id && !(corporationState.isNpcCorporationID && corporationState.isNpcCorporationID(id)) &&
    corporationState.getCorporationRecord(id)).sort((a, b) => a - b);
}

function existingNullAnchor(corporationID, structures) {
  const structureState = require("../structure/structureState");
  const world = require("../../space/worldData");
  return structures.find((entry) => positiveID(entry.ownerCorpID || entry.ownerID) === corporationID && !entry.unanchoring &&
    Number(entry.state) >= 100 && Number((world.getSolarSystemByID(entry.solarSystemID) || {}).security) <= 0 &&
    structureState.getStructureTypeByID(positiveID(entry.typeID))?.dockable);
}

function buildPlan(options = {}) {
  const map = require("./playerBotMapApiRuntime").buildStaticMap();
  const world = require("../../space/worldData");
  const corporationState = require("../corporation/corporationState");
  const structureState = require("../structure/structureState");
  const structures = (typeof structureState.peekStructures === "function" ? structureState.peekStructures() : structureState.listStructures())
    .filter((entry) => entry && !entry.destroyedAt);
  const adjacency = new Map();
  for (const [a, b] of map.links || []) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!adjacency.has(x)) adjacency.set(x, new Set());
      adjacency.get(x).add(y);
    }
  }
  // Regions that are claimable null-sec and not held by anyone yet.
  const sovHeld = new Set();
  try {
    for (const entry of require("../sovereignty/sovState").listAllSovereigntySystemStates() || []) {
      if (positiveID(entry.allianceID) || positiveID(entry.corporationID)) sovHeld.add(positiveID(entry.solarSystemID || entry.systemID));
    }
  } catch (_) { /* no sovereignty yet */ }
  const regions = new Map();
  const systems = new Map();
  for (const [id, name, x, y, z, sec, regionID] of map.systems || []) {
    systems.set(id, { id, name, x, y, z, sec, regionID });
    if (id >= KSPACE_MAX_SYSTEM_ID) continue;
    const region = regions.get(regionID) || { regionID, name: (map.names || {})[regionID] || `Region ${regionID}`, ids: [], claimable: 0, held: 0, x: 0, y: 0, z: 0 };
    region.ids.push(id);
    region.x += x; region.y += y; region.z += z;
    if (sec <= 0 && claimable(id)) region.claimable += 1;
    if (sovHeld.has(id)) region.held += 1;
    regions.set(regionID, region);
  }
  for (const region of regions.values()) {
    region.x /= region.ids.length; region.y /= region.ids.length; region.z /= region.ids.length;
  }
  const candidateRegions = [...regions.values()].filter((region) => region.ids.length >= 15 && region.claimable / region.ids.length >= 0.8);

  const corporations = corporationsToSeed(options);
  const plan = [];
  const usedRegions = new Set();
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const homeIn = (region, preferredSystemID = 0) => {
    const score = (id) => {
      const system = systems.get(id);
      if (!system || system.sec > 0 || !claimable(id)) return -1;
      const near = [...(adjacency.get(id) || [])].filter((n) => systems.get(n)?.regionID === region.regionID && systems.get(n).sec <= 0 && claimable(n));
      if (near.length < CLAIMS - 1) return -1;
      const belts = (world.getAsteroidBeltsForSystem(id) || []).length;
      return Math.min(belts, 6) * 3 + near.length * 2 + (sovHeld.has(id) ? -50 : 0);
    };
    if (preferredSystemID && score(preferredSystemID) >= 0) return preferredSystemID;
    return region.ids.map((id) => [id, score(id)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || 0;
  };
  const claimsAround = (home, region) => {
    const near = [...(adjacency.get(home) || [])].filter((n) => systems.get(n)?.regionID === region.regionID && systems.get(n).sec <= 0 && claimable(n))
      .sort((a, b) => (world.getAsteroidBeltsForSystem(b) || []).length - (world.getAsteroidBeltsForSystem(a) || []).length || a - b);
    return [home, ...near.slice(0, CLAIMS - 1)];
  };

  // Corporations that already have a null-sec station keep that region.
  const pending = [];
  for (const corporationID of corporations) {
    const record = corporationState.getCorporationRecord(corporationID) || {};
    const entry = { corporationID, name: record.corporationName || `Corporation ${corporationID}`, allianceID: positiveID(record.allianceID), ceoID: positiveID(record.ceoID) };
    const anchor = existingNullAnchor(corporationID, structures);
    const region = anchor && regions.get(systems.get(positiveID(anchor.solarSystemID))?.regionID);
    if (region) {
      usedRegions.add(region.regionID);
      const home = homeIn(region, positiveID(anchor.solarSystemID)) || positiveID(anchor.solarSystemID);
      plan.push({ ...entry, regionID: region.regionID, regionName: region.name, homeSystemID: home, claims: claimsAround(home, region), existingRegion: true });
    } else pending.push(entry);
  }
  // Spread the rest: each next region is the one farthest from those taken.
  const free = candidateRegions.filter((region) => !usedRegions.has(region.regionID) && region.held / region.ids.length < 0.2);
  for (const entry of pending) {
    const taken = plan.map((p) => regions.get(p.regionID));
    const choice = free.filter((region) => !usedRegions.has(region.regionID))
      .map((region) => [region, taken.length ? Math.min(...taken.map((t) => distance(region, t))) : -region.held])
      .sort((a, b) => b[1] - a[1] || a[0].regionID - b[0].regionID)[0];
    if (!choice) { plan.push({ ...entry, error: "No free null-sec region is left." }); continue; }
    const region = choice[0];
    usedRegions.add(region.regionID);
    const home = homeIn(region);
    if (!home) { plan.push({ ...entry, regionID: region.regionID, regionName: region.name, error: "No suitable home system in the region." }); continue; }
    plan.push({ ...entry, regionID: region.regionID, regionName: region.name, homeSystemID: home, claims: claimsAround(home, region) });
  }
  const names = (id) => systems.get(id)?.name || String(id);
  const missingTypes = [...new Set(STRUCTURES.flatMap((s) => s.modules).concat(["Nitrogen Fuel Block", "Rifter Blueprint"], MINERALS.map((m) => m[0])))]
    .filter((name) => !typeID(name));
  const botCounts = new Map();
  const { readSharedCharacterRecord } = require("../character/characterState");
  for (const bot of require("./playerBotRuntime").listBots()) {
    const id = positiveID((readSharedCharacterRecord(Number(bot.characterID)) || {}).corporationID ?? bot.corporationID);
    botCounts.set(id, (botCounts.get(id) || 0) + 1);
  }
  return {
    corporations: plan.map((entry) => ({
      ...entry,
      homeSystemName: entry.homeSystemID ? names(entry.homeSystemID) : "",
      claimNames: (entry.claims || []).map(names),
      bots: botCounts.get(entry.corporationID) || 0,
      needsAlliance: !entry.allianceID,
    })),
    package: { structures: STRUCTURES.map((s) => s.type), claims: CLAIMS, isk: CORP_ISK, fuelBlocks: FUEL_BLOCKS },
    missingTypes,
  };
}

// ------------------------------------------------------------ steps

function findSeeded(corporationID, role) {
  const structureState = require("../structure/structureState");
  const rows = typeof structureState.peekStructures === "function" ? structureState.peekStructures() : structureState.listStructures();
  return rows.find((entry) => entry && !entry.destroyedAt && entry.devFlags && entry.devFlags.playerBotWorldSeed &&
    positiveID(entry.devFlags.playerBotWorldSeed.corporationID) === corporationID && entry.devFlags.playerBotWorldSeed.role === role) || null;
}

function deploymentPosition(systemID, typeIDValue, index) {
  const world = require("../../space/worldData");
  const placement = require("../structure/structureDeploymentPlacement");
  const celestials = (world.getCelestialsForSystem(systemID) || []).filter((c) => Number(c.groupID) === 7);
  const anchors = celestials.length ? celestials : (world.getCelestialsForSystem(systemID) || []);
  const pick = anchors[index % Math.max(1, anchors.length)] || {};
  const base = pick.position || { x: Number(pick.x) || 0, y: Number(pick.y) || 0, z: Number(pick.z) || 0 };
  for (const radius of [3_000_000, 6_000_000, 12_000_000, 25_000_000, 50_000_000]) {
    for (let step = 0; step < 16; step += 1) {
      const angle = Math.PI * 2 * (step + index * 5) / 16;
      const offset = { x: Math.round(Math.cos(angle) * radius), y: 0, z: Math.round(Math.sin(angle) * radius) };
      const position = { x: Number(base.x || 0) + offset.x, y: Number(base.y || 0), z: Number(base.z || 0) + offset.z };
      try {
        if (placement.validateDeploymentPlacement({ solarSystemID: systemID, typeID: typeIDValue, position, offset }).success) return position;
      } catch (_) { /* try the next spot */ }
    }
  }
  return null;
}

// Mirrors EveJS's own online automation (structureAutoState), without the
// waiting: anchor, fast-forward the timers, install the core, dock online.
function bringOnline(structureID) {
  const structureState = require("../structure/structureState");
  const { STRUCTURE_STATE, STRUCTURE_SERVICE_ID, STRUCTURE_SERVICE_STATE } = require("../structure/structureConstants");
  for (let step = 0; step < 16; step += 1) {
    const structure = structureState.getStructureByID(structureID, { refresh: false });
    if (!structure || structure.destroyedAt) throw new Error("structure vanished while coming online");
    const current = Number(structure.state) || 0;
    const docking = Number(structure.serviceStates && structure.serviceStates[String(STRUCTURE_SERVICE_ID.DOCKING)]);
    if (current === STRUCTURE_STATE.SHIELD_VULNERABLE && docking === STRUCTURE_SERVICE_STATE.ONLINE) return structure;
    let result;
    if (current === STRUCTURE_STATE.UNANCHORED) result = structureState.startAnchoring(structureID);
    else if (current === STRUCTURE_STATE.ANCHOR_VULNERABLE) result = structureState.fastForwardStructure(structureID, 7 * 24 * 3600);
    else if (current === STRUCTURE_STATE.ANCHORING || current === STRUCTURE_STATE.ONLINING_VULNERABLE) {
      if (structure.hasQuantumCore !== true) result = structureState.setStructureQuantumCoreInstalled(structureID, true);
      else if (current === STRUCTURE_STATE.ONLINING_VULNERABLE && docking !== STRUCTURE_SERVICE_STATE.ONLINE) {
        result = structureState.setStructureServiceState(structureID, STRUCTURE_SERVICE_ID.DOCKING, STRUCTURE_SERVICE_STATE.ONLINE);
      } else result = structureState.fastForwardStructure(structureID, 7 * 24 * 3600);
    } else if (current === STRUCTURE_STATE.SHIELD_VULNERABLE) {
      result = structureState.setStructureServiceState(structureID, STRUCTURE_SERVICE_ID.DOCKING, STRUCTURE_SERVICE_STATE.ONLINE);
    } else throw new Error(`structure is in state ${current}, which the seed cannot advance`);
    if (result && result.success === false) throw new Error(result.errorMsg || "structure state change refused");
  }
  throw new Error("structure did not come online");
}

function grant(ownerID, locationID, flagID, entries, receiptKey) {
  const itemStore = require("../inventory/itemStore");
  const grants = entries.map(([itemType, quantity, options]) => ({ itemType, quantity, options: options || {} }));
  const result = typeof itemStore.grantItemsToOwnerLocationIdempotent === "function"
    ? itemStore.grantItemsToOwnerLocationIdempotent(ownerID, locationID, flagID, grants, { receiptKey })
    : itemStore.grantItemsToOwnerLocation(ownerID, locationID, flagID, grants);
  if (!result || result.success === false) throw new Error(result && result.errorMsg || "item grant refused");
  return result;
}

function fitAndFuel(entry, spec, structureID) {
  const modules = require("../structure/structureServiceModules");
  const itemStore = require("../inventory/itemStore");
  const fuel = typeID("Nitrogen Fuel Block");
  if (fuel) grant(entry.corporationID, structureID, modules.STRUCTURE_FUEL_BAY_FLAG, [[fuel, FUEL_BLOCKS]], `world-seed:fuel:${structureID}`);
  spec.modules.forEach((name, index) => {
    const moduleTypeID = typeID(name);
    if (!moduleTypeID) return;
    const flag = modules.STRUCTURE_SERVICE_SLOT_FLAGS[index];
    grant(entry.corporationID, structureID, flag, [[moduleTypeID, 1, { singleton: 1 }]], `world-seed:module:${structureID}:${flag}`);
  });
  for (const module of modules.listFittedStructureServiceModules(structureID) || []) {
    const item = itemStore.findItemById(Number(module.itemID)) || module;
    try { modules.tryAutoOnlineFittedStructureServiceModule(structureID, item); } catch (error) { note(`${entry.name}: ${name(item)} did not online (${error.message})`); }
  }
  function name(item) { return String(item.itemName || item.typeName || item.typeID); }
}

async function seedStructures(entry) {
  const structureState = require("../structure/structureState");
  entry.structures = entry.structures || {};
  STRUCTURES.forEach((spec, index) => {
    let structure = findSeeded(entry.corporationID, spec.role);
    if (!structure) {
      const position = deploymentPosition(entry.homeSystemID, spec.typeID, index);
      if (!position) throw new Error(`no legal spot for the ${spec.type} in ${entry.homeSystemName}`);
      const result = structureState.seedStructureForSession(null, spec.type, {
        ownerCorpID: entry.corporationID,
        allianceID: entry.allianceID || null,
        solarSystemID: entry.homeSystemID,
        position,
        name: `${entry.homeSystemName} - ${entry.name.slice(0, 24)} ${spec.role === "headquarters" ? "HQ" : spec.role === "industry" ? "Works" : "Refinery"}`,
        devFlags: { playerBotWorldSeed: { corporationID: entry.corporationID, role: spec.role } },
      });
      if (!result || result.success === false) throw new Error(result && result.errorMsg || "structure creation refused");
      structure = result.data;
    }
    const structureID = positiveID(structure.structureID || structure.itemID);
    bringOnline(structureID);
    fitAndFuel(entry, spec, structureID);
    entry.structures[spec.role] = structureID;
  });
  // The Astrahus is the corporation's headquarters for its bots.
  const hq = entry.structures.headquarters;
  const { headquartersStructureDevFlags } = require("./playerBotPiWorkPolicy");
  structureState.updateStructureRecord(hq, (current) => ({ ...current, devFlags: headquartersStructureDevFlags(current.devFlags, entry.corporationID) }));
  try { require("./playerBotCorpCommands").runCorporationCommand(entry.corporationID, "hq-set", { target: hq }); } catch (error) { note(`${entry.name}: HQ not saved (${error.message})`); }
}

function seedAlliance(entry) {
  if (entry.allianceID) return;
  const corporationState = require("../corporation/corporationState");
  const base = entry.name.replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 40) || `Corporation ${entry.corporationID}`;
  const result = corporationState.createCustomAllianceForCorporation(entry.ceoID, entry.corporationID, `${base} Dominion`, {
    shortName: base.replace(/[^A-Z]/gi, "").slice(0, 4).toUpperCase() || "SEED",
  });
  if (!result || result.success === false) throw new Error(result && result.errorMsg || "alliance creation refused");
  entry.allianceID = positiveID(corporationState.getCorporationRecord(entry.corporationID)?.allianceID) ||
    positiveID(result.data && (result.data.allianceID || result.data));
  if (!entry.allianceID) throw new Error("alliance was not recorded on the corporation");
}

function seedSovereignty(entry) {
  const sov = require("../sovereignty/sovGmState");
  for (const systemID of entry.claims) {
    const result = sov.captureSystemForOwner(systemID, entry.allianceID, entry.corporationID);
    if (!result || result.success === false) note(`${entry.name}: sovereignty in ${systemID} refused (${result && result.errorMsg})`);
  }
}

function seedClaims(entry) {
  const territory = require("./playerBotTerritoryClaimsRuntime");
  const held = territory.getClaims()[entry.corporationID] || [];
  for (const systemID of entry.claims) {
    if (held.includes(systemID)) continue;
    const result = territory.claim(entry.corporationID, systemID);
    if (!result.success) note(`${entry.name}: claim ${systemID} refused (${result.message})`);
  }
}

async function seedWallet(entry) {
  const wallet = require("../corporation/corpWalletState");
  const result = await wallet.adjustCorporationWalletDivisionBalanceAsync(entry.corporationID, 1000, CORP_ISK, {
    description: "World seed starting funds", idempotencyKey: `world-seed:isk:${entry.corporationID}`,
  });
  if (result && result.success === false) throw new Error(result.errorMsg || "wallet credit refused");
}

function queueMoves(entry) {
  const { readSharedCharacterRecord } = require("../character/characterState");
  let controlled = new Set();
  try { controlled = new Set([...require("./playerBotCapacityRuntime").getHumanControlledBotIDs()].map(Number)); } catch (_) { controlled = new Set(); }
  for (const bot of require("./playerBotRuntime").listBots()) {
    const characterID = Number(bot.characterID);
    const character = readSharedCharacterRecord(characterID) || {};
    if (positiveID(character.corporationID ?? bot.corporationID) !== entry.corporationID || controlled.has(characterID)) continue;
    const role = STRUCTURE_FOR_SPECIALTY[bot.specialty] || "headquarters";
    const target = entry.structures[role] || entry.structures.headquarters;
    if (positiveID(character.structureID) === target) continue;
    state.queue.push({ characterID, characterName: bot.characterName, target, corporationID: entry.corporationID });
  }
}

function moveBot(job) {
  const bot = require("./playerBotRuntime").listBots().find((entry) => Number(entry.characterID) === job.characterID);
  if (!bot) return;
  const operations = require("./playerBotOperationRuntime");
  if (operations.hasActiveOperation(job.characterID)) {
    try { operations.stopOperation(job.characterName); } catch (_) { /* moved anyway */ }
  }
  const session = require("./playerBotSpaceRuntime").getActorSession(bot);
  const result = require("../../space/transitions").jumpSessionToDockableLocation(session, job.target);
  if (result && result.success === false) throw new Error(result.errorMsg || "move refused");
}

async function seedOrdersAndJobs(entry) {
  const { readSharedCharacterRecord } = require("../character/characterState");
  const itemStore = require("../inventory/itemStore");
  const hangar = itemStore.ITEM_FLAGS ? itemStore.ITEM_FLAGS.HANGAR : 4;
  const members = require("./playerBotRuntime").listBots().filter((bot) =>
    positiveID((readSharedCharacterRecord(Number(bot.characterID)) || {}).corporationID ?? bot.corporationID) === entry.corporationID);
  const at = (bot, structureID) => positiveID((readSharedCharacterRecord(Number(bot.characterID)) || {}).structureID) === structureID;
  const trade = require("./playerBotTradeRuntime");
  const economy = require("./playerBotEconomyRuntime");
  const price = (id, fallback) => Number(economy.getJitaReferencePrice?.(id)) || fallback;
  // Market: traders list minerals for sale and keep bids at the headquarters.
  const traders = members.filter((bot) => at(bot, entry.structures.headquarters))
    .sort((a, b) => Number(b.specialty === "trade") - Number(a.specialty === "trade")).slice(0, ORDER_TRADERS);
  for (const bot of traders) {
    const tritanium = typeID("Tritanium");
    const pyerite = typeID("Pyerite");
    try {
      grant(bot.characterID, entry.structures.headquarters, hangar, [[tritanium, 200_000], [pyerite, 80_000]], `world-seed:stock:${bot.characterID}`);
      const stacks = require("./playerBotInventoryRuntime").listHangar(bot, entry.structures.headquarters) || [];
      for (const stack of stacks.filter((s) => [tritanium, pyerite].includes(Number(s.typeID)))) {
        await trade.listSellOrder(bot.characterName, stack.itemID, null, Math.round(price(Number(stack.typeID), 6) * 1.05 * 100) / 100, 30);
      }
      for (const [name, units, fallback] of [["Isogen", 20_000, 60], ["Nocxium", 5_000, 400]]) {
        await trade.placeBuyOrder(bot.characterName, typeID(name), units, Math.round(price(typeID(name), fallback) * 0.9 * 100) / 100, 30);
      }
    } catch (error) { note(`${entry.name}: market orders for ${bot.characterName} failed (${error.message})`); }
  }
  // Industry: builders get a Rifter blueprint and minerals at the Raitaru.
  const builders = members.filter((bot) => at(bot, entry.structures.industry))
    .sort((a, b) => Number(b.specialty === "industry") - Number(a.specialty === "industry")).slice(0, JOB_BUILDERS);
  for (const bot of builders) {
    try {
      grant(bot.characterID, entry.structures.industry, hangar,
        [[typeID("Rifter Blueprint"), 1, { singleton: 1 }], ...MINERALS.map(([name, quantity]) => [typeID(name), quantity])],
        `world-seed:industry:${bot.characterID}`);
      const blueprint = (require("./playerBotInventoryRuntime").listHangar(bot, entry.structures.industry) || [])
        .find((s) => Number(s.typeID) === typeID("Rifter Blueprint"));
      if (blueprint) require("./playerBotIndustryRuntime").setAutoManufacturingPolicy(bot.characterName, blueprint.itemID, 5, 50_000_000);
    } catch (error) { note(`${entry.name}: manufacturing for ${bot.characterName} failed (${error.message})`); }
  }
}

// ------------------------------------------------------------ the run

function note(message) {
  state.errors = [...(state.errors || []), String(message).slice(0, 240)].slice(-200);
  try { deps.log().warn(`[PlayerBots] World seed: ${message}`); } catch (_) { /* logging is best effort */ }
}

const STEPS = ["alliance", "structures", "sovereignty", "claims", "wallet"];

async function runCorporationSteps() {
  for (const entry of Object.values(state.corporations)) {
    if (entry.error) continue;
    for (const step of STEPS) {
      if (entry.done[step]) continue;
      state.step = `${entry.name}: ${step}`;
      try {
        if (step === "alliance") { if (state.options.sovereignty) seedAlliance(entry); }
        else if (step === "structures") await seedStructures(entry);
        else if (step === "sovereignty") { if (state.options.sovereignty && entry.allianceID) seedSovereignty(entry); }
        else if (step === "claims") seedClaims(entry);
        else if (step === "wallet") await seedWallet(entry);
        entry.done[step] = true;
      } catch (error) {
        note(`${entry.name}: ${step} failed (${error.message})`);
        if (step === "structures") { entry.error = error.message; break; }
      }
      save();
      await new Promise((resolve) => deps.schedule(resolve, 20)); // let the server breathe between steps
    }
  }
}

async function runMoves() {
  state.queue = [];
  for (const entry of Object.values(state.corporations)) if (!entry.error && entry.structures) queueMoves(entry);
  state.toMove = state.queue.length;
  state.moved = 0;
  while (state.queue.length) {
    state.step = `Moving bots into their structures (${state.moved} of ${state.toMove})`;
    for (const job of state.queue.splice(0, MOVE_BATCH)) {
      try { moveBot(job); } catch (error) { if ((state.errors || []).length < 150) note(`move ${job.characterName} failed (${error.message})`); }
      state.moved += 1;
    }
    if (state.moved % 200 < MOVE_BATCH) save();
    await new Promise((resolve) => deps.schedule(resolve, BATCH_DELAY_MS));
  }
}

async function run() {
  try {
    await runCorporationSteps();
    if (state.options.moveBots) await runMoves();
    if (state.options.ordersAndJobs) {
      for (const entry of Object.values(state.corporations)) {
        if (entry.error || entry.done.market || !entry.structures) continue;
        state.step = `${entry.name}: market orders and jobs`;
        await seedOrdersAndJobs(entry);
        entry.done.market = true;
        save();
      }
    }
    try {
      const configuration = require("./playerBotConfigurationRuntime");
      if (Number(configuration.getSettings().riskTolerance) < 2) configuration.updateSettings({ riskTolerance: 2 });
    } catch (error) { note(`risk tolerance not raised (${error.message})`); }
    state.status = "finished";
  } catch (error) {
    note(`run stopped (${error.message})`);
    state.status = "failed";
  }
  state.finishedAt = new Date().toISOString();
  state.step = "";
  save();
  try { deps.log().info(`[PlayerBots] World seed ${state.status}: ${Object.keys(state.corporations).length} corporations, ${state.moved || 0} bots moved, ${(state.errors || []).length} notes.`); } catch (_) { /* best effort */ }
}

function startSeed(options = {}) {
  load();
  if (isRunning()) return { success: false, message: "A world seed is already running." };
  if (options.confirmation !== "SEED NEW EDEN") return { success: false, message: "Type SEED NEW EDEN to confirm." };
  const plan = buildPlan(options);
  if (plan.missingTypes.length) return { success: false, message: `These item types are missing from the static data: ${plan.missingTypes.join(", ")}.` };
  const previous = state.corporations || {};
  state = {
    status: "running",
    startedAt: new Date().toISOString(),
    options: { sovereignty: options.sovereignty !== false, moveBots: options.moveBots !== false, ordersAndJobs: options.ordersAndJobs !== false },
    corporations: {},
    errors: [],
    queue: [],
  };
  for (const entry of plan.corporations) {
    const before = previous[entry.corporationID];
    // A repeated run keeps what an earlier run finished for the corporation.
    state.corporations[entry.corporationID] = before && !before.error
      ? { ...before, done: before.done || {} }
      : { ...entry, done: {} };
  }
  save();
  deps.schedule(() => { run().catch((error) => note(`run crashed (${error.message})`)); }, 50);
  return { success: true, message: `Seeding ${plan.corporations.length} corporations.`, status: getStatus() };
}

module.exports = {
  CONFIRMATION: "SEED NEW EDEN",
  buildPlan,
  startSeed,
  getStatus,
  isRunning,
  _testing: { setDeps: (next) => { deps = { ...defaultDeps(), ...next }; state = null; }, bringOnline, STRUCTURES },
};
