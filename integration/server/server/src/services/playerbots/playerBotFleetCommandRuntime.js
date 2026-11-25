"use strict";

// Fleet duty: a human fleet commander (FC) tells the bots in the fleet what
// kind of fleet it is, from the dashboard's Fleet page. Every bot then
//   1. checks it flies a ship fitted for the job, and fetches one if not
//      (the FC's saved fitting for that job when one is set, otherwise the
//      built-in Playerbots fit);
//   2. meets the FC: it docks where the FC is docked and undocks when the FC
//      undocks;
//   3. follows the FC through warp;
//   4. works the grid the FC is on: mines and unloads into the FC's fleet
//      hangar (or a jet can), kills every rat, hauls the fleet's jet cans to
//      the FC, or guards the FC.
// The choices are kept per FC, so they survive a restart and apply to any
// fleet that FC forms with bots.

const TABLE = "playerBots";
const DOCTRINE_PREFIX = "_playerBotFleetDoctrine_";

const FLEET_TYPES = Object.freeze({
  mining: Object.freeze({
    label: "Mining",
    role: "mining",
    summary: "Mine the asteroids on the FC's grid with lasers and mining drones. Full holds go into the FC's fleet hangar, or into a jet can when there is no room.",
  }),
  combat: Object.freeze({
    label: "Combat",
    role: "security",
    summary: "Kill every rat on the FC's grid with drones, fighters and guns, starting with the FC's own target.",
  }),
  hauling: Object.freeze({
    label: "Hauling",
    role: "logistics",
    summary: "Pick up the fleet's jet cans and deliver the cargo to the FC's fleet hangar.",
  }),
  escort: Object.freeze({
    label: "Escort",
    role: "security",
    summary: "Stay close to the FC and fight the rats that come near.",
  }),
});
const TYPE_KEYS = Object.freeze(Object.keys(FLEET_TYPES));

const STEP_MS = 4_000;
const DOCKED_WATCH_MS = 3_000;
const WARP_WAIT_MS = 2_000;
const FC_OFFLINE_MS = 15_000;
const FC_OFFLINE_GIVE_UP_MS = 15 * 60 * 1000;
const WARP_RANGE_METERS = 150_000;
const TRANSFER_RANGE_METERS = 2_000;
const CAN_PICKUP_RANGE_METERS = 2_000;
const DRONE_RECALL_WAIT_MS = 25_000;
const FIT_CHECK_MS = 60_000;
const UNLOAD_AT_FILL = 0.9;
const MAX_REFIT_ATTEMPTS = 2;
const RECONCILE_MS = 5_000;
const RESTART_BACKOFF_MS = 20_000;
const STALE_STEP_MS = 30_000;
const MAX_LAUNCHED_DRONES = 5;
const THREAT_MEMORY_MS = 60_000;
const FOLLOW_RANGE = Object.freeze({ mining: 5_000, combat: 5_000, hauling: 2_500, escort: 2_500 });
const ESCORT_GUARD_RADIUS_METERS = 30_000;
const DRONE_CONTROL_RANGE_METERS = 20_000;

// Drone groups that do not fight: mining, salvage and repair drones.
const MINING_DRONE_GROUP = 101;
const NON_COMBAT_DRONE_GROUPS = new Set([101, 1159, 640]);
const DRONE_CATEGORY = 18;
const ASTEROID_CATEGORY = 25;
const HIGH_SLOT_FLAGS = [27, 28, 29, 30, 31, 32, 33, 34];
const FIGHTER_TUBE_FLAGS = [159, 160, 161, 162, 163];
const FLEET_HANGAR_FLAG = 155;
const WEAPON_EFFECTS = new Set(["targetattack", "projectilefired", "usemissiles", "targetdisintegratorattack"]);
// Work a bot may drop the moment its FC calls it: it is idle or easily resumed.
const PREEMPTIBLE_KINDS = new Set(["mine", "fleet-follow", "fleet-attack"]);

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function lazy(path) {
  let cached;
  return () => (cached ||= require(path));
}

const deps = {
  fleetRuntime: lazy("../fleets/fleetRuntime"),
  playerBots: lazy("./playerBotRuntime"),
  operations: lazy("./playerBotOperationRuntime"),
  sessionRegistry: lazy("../chat/sessionRegistry"),
  characters: lazy("../character/characterState"),
  itemStore: lazy("../inventory/itemStore"),
  registry: lazy("../inventory/itemTypeRegistry"),
  fitting: lazy("../fitting/liveFittingState"),
  inventory: lazy("./playerBotInventoryRuntime"),
  space: lazy("./playerBotSpaceRuntime"),
  combatPolicy: lazy("./playerBotCombatPolicy"),
  combatRuntime: lazy("./playerBotCombatRuntime"),
  droneRuntime: lazy("../drone/droneRuntime"),
  worldData: lazy("../../space/worldData"),
  logger: lazy("../../utils/logger"),
};

function warn(message) {
  try { deps.logger().warn(`[PlayerBots] Fleet duty: ${message}`); } catch { /* logging is best effort */ }
}

// ------------------------------------------------------------- doctrine store

let repository = null;
const doctrines = new Map();
let doctrinesLoaded = false;
let storeOverride = null;

function getRepo() {
  if (storeOverride) return storeOverride;
  if (!repository) {
    repository = require("../../gameStore/tableRepository")
      .createTableRepository("service:playerbots", { strict: true });
  }
  return repository;
}

function blankFits() {
  return Object.fromEntries(TYPE_KEYS.map((key) => [key, 0]));
}

function normalizeDoctrine(raw) {
  const commanderID = positive(raw && raw.commanderID);
  if (!commanderID) return null;
  const fits = blankFits();
  for (const key of TYPE_KEYS) fits[key] = positive(raw.fits && raw.fits[key]);
  const selected = Array.isArray(raw.botIDs) ? [...new Set(raw.botIDs.map(positive).filter(Boolean))].slice(0, 500) : null;
  return {
    commanderID,
    fleetType: TYPE_KEYS.includes(raw.fleetType) ? raw.fleetType : "",
    fits,
    active: raw.active === true && TYPE_KEYS.includes(raw.fleetType),
    botIDs: selected && selected.length ? selected : null,
    updatedAt: String(raw.updatedAt || ""),
  };
}

function loadDoctrines() {
  if (doctrinesLoaded) return;
  doctrinesLoaded = true;
  try {
    const repo = getRepo();
    repo.ensureTable(TABLE);
    const root = repo.read(TABLE, "/");
    const rows = root && root.success && root.data && typeof root.data === "object" ? root.data : {};
    for (const [key, wrapper] of Object.entries(rows)) {
      if (!key.startsWith(DOCTRINE_PREFIX) || !wrapper || !wrapper.playerBotFleetDoctrine) continue;
      const doctrine = normalizeDoctrine(wrapper.playerBotFleetDoctrine);
      if (doctrine) doctrines.set(doctrine.commanderID, doctrine);
    }
  } catch (error) {
    warn(`could not read saved fleet settings: ${error.message}`);
  }
}

function saveDoctrine(doctrine) {
  doctrine.updatedAt = new Date().toISOString();
  doctrines.set(doctrine.commanderID, doctrine);
  const repo = getRepo();
  const result = repo.write(TABLE, `/${DOCTRINE_PREFIX}${doctrine.commanderID}`, {
    playerBotFleetDoctrine: { ...doctrine, fits: { ...doctrine.fits }, botIDs: doctrine.botIDs ? [...doctrine.botIDs] : null },
  });
  if (result && result.success === false) throw new Error(result.errorMsg || "PLAYERBOT_FLEET_SETTINGS_WRITE_FAILED");
  if (typeof repo.flushTableSync === "function") repo.flushTableSync(TABLE);
  return doctrine;
}

function getDoctrine(commanderID) {
  loadDoctrines();
  const id = positive(commanderID);
  return id ? doctrines.get(id) || null : null;
}

function doctrineFor(commanderID) {
  return getDoctrine(commanderID) || normalizeDoctrine({ commanderID, fits: blankFits() });
}

// ------------------------------------------------------------ fleet helpers

function isBotID(characterID) {
  const playerBots = deps.playerBots();
  if (typeof playerBots.hasBotProfile === "function") return playerBots.hasBotProfile(positive(characterID));
  return playerBots.listBots().some((bot) => positive(bot.characterID) === positive(characterID));
}

function getBot(characterID) {
  const playerBots = deps.playerBots();
  if (typeof playerBots.getBotByCharacterID === "function") return playerBots.getBotByCharacterID(positive(characterID));
  return playerBots.listBots().find((bot) => positive(bot.characterID) === positive(characterID)) || null;
}

function memberIDs(fleet) {
  return fleet && fleet.members && typeof fleet.members.keys === "function"
    ? [...fleet.members.keys()].map(positive).filter(Boolean)
    : [];
}

// The FC is the fleet boss when that is a person; otherwise the first person
// who joined. Bots never command a fleet.
function commanderOfFleet(fleet) {
  if (!fleet) return 0;
  const fleetRuntime = deps.fleetRuntime();
  const bossID = positive(typeof fleetRuntime.getBossCharacterID === "function" ? fleetRuntime.getBossCharacterID(fleet) : 0);
  if (bossID && !isBotID(bossID)) return bossID;
  return memberIDs(fleet).find((id) => !isBotID(id)) || 0;
}

function fleetOfCommander(commanderID) {
  const fleet = deps.fleetRuntime().getMemberFleetForCharacter(positive(commanderID));
  return fleet && commanderOfFleet(fleet) === positive(commanderID) ? fleet : null;
}

function selectedBots(doctrine, fleet) {
  const bots = memberIDs(fleet).filter(isBotID);
  if (!doctrine.botIDs) return bots;
  const chosen = new Set(doctrine.botIDs);
  return bots.filter((id) => chosen.has(id));
}

function readCommander(commanderID) {
  const id = positive(commanderID);
  const session = id ? deps.sessionRegistry().findSessionByCharacterID(id) : null;
  if (!session) return { online: false, characterID: id };
  const character = deps.characters().getCharacterRecord(id) || {};
  const stationID = positive(session.stationID || session.stationid || session.structureID || session.structureid);
  const systemID = positive(session.solarsystemid2 || session.solarsystemid || session.solarSystemID || character.solarSystemID);
  const shipID = positive(session.shipID || session.shipid || character.shipID);
  const shipTypeID = positive(session.shipTypeID || session.shiptypeid || character.shipTypeID);
  return {
    online: true,
    characterID: id,
    session,
    stationID,
    systemID,
    shipID,
    shipTypeID,
    inSpace: !stationID && Boolean(session._space),
  };
}

// The FC ship's fleet hangar: its size, what is in it, and whether fleet
// members may put things in.
function fleetHangarInfo(shipID, shipTypeID) {
  const capacity = Number(deps.fitting().getTypeAttributeValue(positive(shipTypeID), "fleetHangarCapacity")) || 0;
  if (!positive(shipID) || capacity <= 0) return { capacity: 0, used: 0, free: 0, fleetAccess: false };
  const itemStore = deps.itemStore();
  const inventory = deps.inventory();
  const used = itemStore.listContainerItems(null, positive(shipID), FLEET_HANGAR_FLAG)
    .reduce((total, item) => total + inventory.getUnitVolume(item) * inventory.unitsOf(item), 0);
  const shipItem = itemStore.findItemById(positive(shipID)) || {};
  let fleetAccess = false;
  try {
    const config = require("../ship/shipServiceAccess").normalizeShipConfiguration(shipItem.shipConfiguration || {});
    fleetAccess = config.FleetHangar_AllowFleetAccess === true;
  } catch { fleetAccess = false; }
  return { capacity, used, free: Math.max(0, capacity - used), fleetAccess };
}

// ------------------------------------------------------------- fit checks

function typeInfo(typeID) {
  try { return deps.registry().resolveItemByTypeID(positive(typeID)) || null; } catch { return null; }
}

function shipItems(bot) {
  const character = deps.characters().getCharacterRecord(bot.characterID) || {};
  const shipID = positive(character.shipID);
  return { character, shipID, items: shipID ? deps.itemStore().listCharacterItems(bot.characterID, { locationID: shipID }) : [] };
}

function droneStacks(bot, shipID, wantMining) {
  const itemStore = deps.itemStore();
  return itemStore.listCharacterItems(bot.characterID, { locationID: shipID, flagID: itemStore.ITEM_FLAGS.DRONE_BAY })
    .filter((item) => {
      const type = typeInfo(item.typeID);
      if (!type || positive(type.categoryID) !== DRONE_CATEGORY) return false;
      const groupID = positive(type.groupID);
      return wantMining ? groupID === MINING_DRONE_GROUP : !NON_COMBAT_DRONE_GROUPS.has(groupID);
    });
}

function weaponModules(items) {
  const fitting = deps.fitting();
  return items.filter((item) => HIGH_SLOT_FLAGS.includes(Number(item.flagID)) && fitting.isFittedModuleItem(item))
    .map((item) => ({ item, effect: weaponEffectName(item.typeID) }))
    .filter((entry) => entry.effect);
}

function weaponEffectName(typeID) {
  try {
    const record = require("../../space/runtime/moduleActivationEffectRecord").resolveDefaultActivationEffect(positive(typeID));
    const name = String(record && record.name || "");
    return WEAPON_EFFECTS.has(name.toLowerCase()) ? name : "";
  } catch {
    return "";
  }
}

function fighterStacks(bot, shipID) {
  const itemStore = deps.itemStore();
  return itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
    .filter((item) => Number(item.flagID) === Number(itemStore.ITEM_FLAGS.FIGHTER_BAY) || FIGHTER_TUBE_FLAGS.includes(Number(item.flagID)));
}

// Does the active ship carry the FC's saved fitting for this job? The hull
// must match and every fitted module of the saved fit must be on it.
function matchesSavedFit(bot, fittingID) {
  const saved = require("../../_secondary/fitting/fittingStore").findFittingByID(positive(fittingID));
  if (!saved) return { ok: false, reason: `Saved fitting ${fittingID} no longer exists.` };
  const planned = require("./playerBotFitPlanner").buildFitPlan(saved);
  if (!planned || !planned.success) return { ok: false, reason: `Saved fitting ${fittingID} cannot be used: ${planned && planned.message || "unknown problem"}` };
  const { character, items } = shipItems(bot);
  if (positive(character.shipTypeID) !== positive(planned.plan.shipTypeID)) {
    return { ok: false, reason: `Not flying the ${saved.name} hull.` };
  }
  const fitting = deps.fitting();
  const fitted = new Map();
  for (const item of items) {
    if (fitting.isFittedModuleItem(item)) fitted.set(positive(item.typeID), (fitted.get(positive(item.typeID)) || 0) + 1);
  }
  const needed = new Map();
  for (const typeID of planned.plan.moduleTypeIDs || []) needed.set(positive(typeID), (needed.get(positive(typeID)) || 0) + 1);
  for (const [typeID, count] of needed) {
    if ((fitted.get(typeID) || 0) < count) return { ok: false, reason: `Missing modules from ${saved.name}.` };
  }
  return { ok: true, reason: `Flying ${saved.name}.` };
}

// A ship "works for the job" when it can do the job at all; the built-in
// ladder fits always qualify, and so do sensible ships of the pilot's own.
function shipFitsJob(bot, fleetType, fittingID = 0) {
  if (positive(fittingID)) return matchesSavedFit(bot, fittingID);
  const operations = deps.operations();
  const { character, shipID, items } = shipItems(bot);
  if (!shipID || positive(character.shipTypeID) === 670) return { ok: false, reason: "In a capsule." };
  if (fleetType === "mining") {
    if (typeof operations.getMiningModules === "function" && operations.getMiningModules(bot).length) return { ok: true, reason: "Mining lasers fitted." };
    if (droneStacks(bot, shipID, true).length) return { ok: true, reason: "Mining drones aboard." };
    return { ok: false, reason: "No mining lasers or mining drones." };
  }
  if (fleetType === "hauling") {
    if (operations.hasRoleShipFit(bot, "logistics")) return { ok: true, reason: "Hauler fit." };
    const capacity = Number(deps.inventory().getCargoBayCapacity(bot)) || 0;
    return capacity >= 2_500
      ? { ok: true, reason: `Cargo hold ${Math.round(capacity).toLocaleString("en-US")} m³.` }
      : { ok: false, reason: "The cargo hold is too small for hauling." };
  }
  // combat and escort
  if (operations.hasRoleShipFit(bot, "security") || operations.hasRoleShipFit(bot, "piracy")) {
    return { ok: true, reason: "Combat fit." };
  }
  const drones = droneStacks(bot, shipID, false).reduce((total, item) => total + deps.inventory().unitsOf(item), 0);
  if (drones >= 2) return { ok: true, reason: "Combat drones aboard." };
  if (weaponModules(items).length) return { ok: true, reason: "Weapons fitted." };
  if (fighterStacks(bot, shipID).length) return { ok: true, reason: "Fighters aboard." };
  return { ok: false, reason: "No weapons, combat drones or fighters." };
}

// --------------------------------------------------------- member status

// In memory only: why a bot is waiting, how many refits it has tried, and
// when it was last started. The dashboard reads this.
const members = new Map();
const threats = new Map();
let enrolled = new Map();

function memberState(characterID) {
  const id = positive(characterID);
  if (!members.has(id)) members.set(id, { note: "", refitAttempts: 0, refitType: "", refitForOperationID: "", lastStartAtMs: 0, refitError: "" });
  return members.get(id);
}

function noteIncomingThreat(characterID, attackerEntityID) {
  const id = positive(characterID);
  const attacker = positive(attackerEntityID);
  if (!id || !attacker) return;
  threats.set(id, { attackerEntityID: attacker, atMs: Date.now() });
}

function recentThreat(characterID) {
  const entry = threats.get(positive(characterID));
  if (!entry) return 0;
  if (Date.now() - entry.atMs > THREAT_MEMORY_MS) {
    threats.delete(positive(characterID));
    return 0;
  }
  return entry.attackerEntityID;
}

// Bots on fleet duty, for the connection plan: they stay online with their FC.
function enrolledIDs() {
  loadDoctrines();
  if (!timer && [...doctrines.values()].some((doctrine) => doctrine.active)) ensureTimer();
  return [...enrolled.keys()];
}

function isEnrolled(characterID) {
  loadDoctrines();
  if (!timer && [...doctrines.values()].some((doctrine) => doctrine.active)) ensureTimer();
  return enrolled.has(positive(characterID));
}

// ------------------------------------------------------------ reconcile tick

let timer = null;
let reconciling = false;

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => { reconcile(); }, RECONCILE_MS);
  if (typeof timer.unref === "function") timer.unref();
  setImmediate(() => reconcile());
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    loadDoctrines();
    const next = new Map();
    let anyActive = false;
    for (const doctrine of doctrines.values()) {
      if (!doctrine.active) continue;
      anyActive = true;
      const fleet = fleetOfCommander(doctrine.commanderID);
      if (!fleet) continue;
      for (const botID of selectedBots(doctrine, fleet)) next.set(botID, doctrine.commanderID);
    }
    enrolled = next;
    for (const [botID, commanderID] of next) {
      try {
        reconcileBot(botID, getDoctrine(commanderID));
      } catch (error) {
        memberState(botID).note = `Could not start fleet duty: ${String(error.message).slice(0, 160)}`;
        warn(`char=${botID}: ${error.message}`);
      }
    }
    if (!anyActive) stopTimer();
  } catch (error) {
    warn(`reconcile failed: ${error.stack || error.message}`);
  } finally {
    reconciling = false;
  }
}

function refitFor(doctrine, bot, state, previous) {
  const operations = deps.operations();
  const fleetType = doctrine.fleetType;
  const fittingID = positive(doctrine.fits[fleetType]);
  if (state.refitType !== `${fleetType}:${fittingID}`) {
    state.refitType = `${fleetType}:${fittingID}`;
    state.refitAttempts = 0;
    state.refitError = "";
  }
  state.refitForOperationID = String(previous.operationID || "");
  if (state.refitAttempts >= MAX_REFIT_ATTEMPTS) return null;
  state.refitAttempts += 1;
  let result;
  if (fittingID) {
    const character = deps.characters().getCharacterRecord(doctrine.commanderID) || {};
    const requester = {
      characterID: doctrine.commanderID,
      corporationID: positive(character.corporationID),
      allianceID: positive(character.allianceID),
    };
    result = operations.startSavedFitting(bot.characterName, fittingID, requester, null, {
      fleetDutyCommanderID: doctrine.commanderID,
    });
  } else {
    result = operations.startShipUpgrade(bot.characterName, FLEET_TYPES[fleetType].role, {
      fleetDutyCommanderID: doctrine.commanderID,
    });
  }
  if (result && result.success) {
    state.note = `Fetching a ${FLEET_TYPES[fleetType].label.toLowerCase()} ship: ${String(result.message || "").slice(0, 160)}`;
    state.refitError = "";
    return result;
  }
  state.refitError = String(result && result.message || "The refit could not start.").slice(0, 200);
  return null;
}

function reconcileBot(botID, doctrine) {
  if (!doctrine || !doctrine.active) return;
  const operations = deps.operations();
  const bot = getBot(botID);
  if (!bot) return;
  const state = memberState(botID);
  if (bot.status === "paused" || bot.autonomyPaused === true) {
    state.note = "Paused on the dashboard; resume the pilot to join the fleet's work.";
    return;
  }
  const current = operations.getOperation(botID);
  const active = current && ["active", "holding"].includes(current.status);
  if (active && current.kind === "fleet-duty") {
    if (positive(current.commanderID) === doctrine.commanderID) state.note = "";
    // A pilot that was offline when it joined has its next step parked until
    // its next login; once it is online, bring that step forward.
    const lastStepAtMs = Date.parse(current.updatedAt || "") || 0;
    if (Date.now() - lastStepAtMs > STALE_STEP_MS && Date.now() - (state.wokeAtMs || 0) > STALE_STEP_MS) {
      state.wokeAtMs = Date.now();
      wake(botID);
    }
    return;
  }
  if (active && ["fit", "upgrade"].includes(current.kind) && positive(current.fleetDutyCommanderID) === doctrine.commanderID) {
    state.note = `Fetching a ${FLEET_TYPES[doctrine.fleetType].label.toLowerCase()} ship (${current.stage}).`;
    return;
  }
  if (current && (current.pending || current.loadSheddingPaused === true)) {
    state.note = `Settling ${current.kind} before joining the fleet.`;
    return;
  }
  if (active) {
    if (PREEMPTIBLE_KINDS.has(current.kind)) {
      const stopped = operations.stopOperation(bot.characterName);
      state.note = stopped && stopped.success ? `Stopping ${current.kind} to join the fleet.` : `Could not stop ${current.kind}: ${stopped && stopped.message || "unknown"}`;
    } else {
      state.note = `Finishing its own ${current.kind} work (${current.stage}) first. "Call in busy bots" brings it now.`;
    }
    return;
  }
  const now = Date.now();
  if (now - state.lastStartAtMs < RESTART_BACKOFF_MS) return;
  state.lastStartAtMs = now;

  let fitWaived = "";
  if (current && current.kind === "fleet-duty" && current.status === "completed" && current.refitNeeded &&
      positive(current.commanderID) === doctrine.commanderID &&
      state.refitForOperationID !== String(current.operationID || "")) {
    if (refitFor(doctrine, bot, state, current)) return;
    fitWaived = doctrine.fleetType;
    state.note = `No ${FLEET_TYPES[doctrine.fleetType].label.toLowerCase()} ship: ${state.refitError || "the refit did not work"} It follows the FC without working.`;
  }
  const started = operations.startFleetDuty(bot.characterName, doctrine.commanderID, {
    fleetType: doctrine.fleetType,
    fitWaivedForType: fitWaived || (state.refitAttempts >= MAX_REFIT_ATTEMPTS ? doctrine.fleetType : ""),
  });
  if (!started.success) state.note = String(started.message || "Could not start fleet duty.").slice(0, 200);
}

// ------------------------------------------------------- in-space helpers

function controlledDrones(scene, shipID) {
  const entities = scene && scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [];
  return [...entities].filter((entity) => entity && entity.kind === "drone" && Number(entity.controllerID) === Number(shipID));
}

function droneGroup(entity) {
  return positive(typeInfo(entity && entity.typeID)?.groupID);
}

function fightersInSpace(scene, shipID) {
  try {
    return require("../fighter/fighterRuntime").buildFightersInSpaceRowsForShip(scene, shipID)
      .map((row) => ({ tubeFlagID: positive(row[0]), itemID: positive(row[1]) }))
      .filter((row) => row.itemID);
  } catch {
    return [];
  }
}

// Calls every drone and fighter back. Returns true while any are still out.
function recallEverything(operation, attached, kit) {
  const { scene, entity, session } = attached;
  const drones = controlledDrones(scene, entity.itemID);
  const fighters = fightersInSpace(scene, entity.itemID);
  if (!drones.length && !fighters.length) {
    if (operation.recallStartedAtMs) {
      delete operation.recallStartedAtMs;
      kit.save(operation);
    }
    return false;
  }
  if (!operation.recallStartedAtMs) {
    operation.recallStartedAtMs = Date.now();
    kit.save(operation);
  }
  if (Date.now() - operation.recallStartedAtMs > DRONE_RECALL_WAIT_MS) {
    kit.record(operation, `Left ${drones.length} drone(s) and ${fighters.length} fighter squadron(s) behind to keep up with the FC.`);
    delete operation.recallStartedAtMs;
    kit.save(operation);
    return false;
  }
  try {
    const returning = drones.filter((drone) => String(drone.activityState || drone.state || "").toLowerCase() !== "returning");
    if (returning.length) deps.droneRuntime().commandReturnBay(session, drones.map((drone) => Number(drone.itemID)));
  } catch { /* the next step asks again */ }
  try {
    if (fighters.length) require("../fighter/fighterRuntime").recallFightersToTubes(session, fighters.map((row) => row.itemID));
  } catch { /* the next step asks again */ }
  return true;
}

function stopLasers(bot) {
  try { deps.space().stopMining(bot); } catch { /* docked or already stopped */ }
}

// Puts ore (or, for haulers, any cargo) into the FC's fleet hangar. Both
// ships must be docked in the same station or within reach in space.
function deliverToCommander(bot, commander, cargoFilter) {
  const inventory = deps.inventory();
  const hangar = fleetHangarInfo(commander.shipID, commander.shipTypeID);
  if (!hangar.capacity) return { moved: 0, reason: "no-hangar" };
  if (!hangar.fleetAccess) return { moved: 0, reason: "no-access" };
  const session = deps.space().getActorSession(bot);
  const botShipID = positive(session.shipID);
  let free = hangar.free;
  let moved = 0;
  let error = "";
  for (const item of inventory.listCargo(bot).filter(cargoFilter)) {
    const volume = inventory.getUnitVolume(item);
    const units = inventory.unitsOf(item);
    const quantity = volume > 0 ? Math.min(units, Math.floor((free + 1e-9) / volume)) : units;
    if (quantity <= 0) break;
    try {
      withBoundShip(session, commander.shipID, (broker) =>
        broker.Handle_Add([Number(item.itemID), botShipID], session, { flag: FLEET_HANGAR_FLAG, qty: quantity }));
      moved += quantity;
      free -= quantity * volume;
    } catch (cause) {
      error = String(cause && cause.message || cause).slice(0, 160);
      break;
    }
  }
  return { moved, reason: moved ? "" : error || "full", error };
}

let invBroker = null;
function withBoundShip(session, shipID, action) {
  if (!invBroker) invBroker = new (require("../inventory/invBrokerService"))();
  const previous = session.currentBoundObjectID;
  try {
    const bound = invBroker.Handle_GetInventoryFromId([positive(shipID)], session, null);
    const boundID = bound && bound.value && Array.isArray(bound.value.value) ? bound.value.value[0] : null;
    if (!boundID) throw new Error("FLEET_HANGAR_BIND_FAILED");
    session.currentBoundObjectID = boundID;
    return action(invBroker);
  } finally {
    session.currentBoundObjectID = previous;
  }
}

function isOre(item) {
  return positive(typeInfo(item && item.typeID)?.categoryID) === ASTEROID_CATEGORY;
}

function visibleEntities(attached) {
  const { scene, session } = attached;
  try {
    return typeof scene.getVisibleEntitiesForSession === "function" ? scene.getVisibleEntitiesForSession(session) || [] : [];
  } catch {
    return [];
  }
}

function distanceBetween(left, right) {
  if (!left || !right || !left.position || !right.position) return Infinity;
  const dx = Number(left.position.x) - Number(right.position.x);
  const dy = Number(left.position.y) - Number(right.position.y);
  const dz = Number(left.position.z) - Number(right.position.z);
  const centre = Math.hypot(dx, dy, dz);
  return Number.isFinite(centre)
    ? Math.max(0, centre - Math.max(0, Number(left.radius) || 0) - Math.max(0, Number(right.radius) || 0))
    : Infinity;
}

function isAlive(entity) {
  return Boolean(entity) && entity.destructionState !== "destroying" && entity.destroying !== true && entity.destroyed !== true;
}

function keepNear(bot, attached, targetID, range) {
  const { entity } = attached;
  if (positive(entity.followTargetID) === positive(targetID) && Math.abs((Number(entity.followRange) || 0) - range) < 1) return;
  deps.space().approach(bot, targetID, range);
}

// ------------------------------------------------------------- the duty

function describe(type) {
  return FLEET_TYPES[type] ? FLEET_TYPES[type].label.toLowerCase() : "fleet";
}

// Records what the pilot is doing. Within one stage the note is refreshed at
// most every 30 seconds, so a busy grid does not write every few seconds.
const STAGE_NOTE_MS = 30_000;
function setStage(operation, stage, message, kit) {
  if (operation.stage === stage && operation.lastAction === message) return;
  const now = Date.now();
  if (operation.stage === stage && now - (Number(operation.stageNotedAtMs) || 0) < STAGE_NOTE_MS) return;
  operation.stage = stage;
  operation.stageNotedAtMs = now;
  kit.record(operation, message);
  kit.save(operation);
}

function windDown(operation, bot, reason, kit) {
  let attached = null;
  try { if (deps.space().getSpaceState(bot).inSpace) attached = deps.space().getActorSpace(bot); } catch { attached = null; }
  if (attached) {
    stopLasers(bot);
    if (recallEverything(operation, attached, kit)) {
      setStage(operation, "leaving", `${reason} Recalling drones first.`, kit);
      return { delayMs: STEP_MS };
    }
  }
  if (operation.routeTaskID && kit.clearRouteTask) kit.clearRouteTask(operation);
  return kit.finish(operation, `${reason} Fleet duty ended; normal work resumes.`);
}

async function advanceFleetDuty(operation, bot, kit) {
  const commanderID = positive(operation.commanderID);
  const doctrine = getDoctrine(commanderID);
  if (operation.stopRequested === true) return windDown(operation, bot, operation.stopReason || "The FC stood the fleet down.", kit);
  if (!doctrine || !doctrine.active) return windDown(operation, bot, "The FC stood the fleet down.", kit);
  const fleet = fleetOfCommander(commanderID);
  const botFleet = deps.fleetRuntime().getMemberFleetForCharacter(positive(bot.characterID));
  if (!fleet || !botFleet || Number(fleet.fleetID) !== Number(botFleet.fleetID)) {
    return windDown(operation, bot, "The pilot is no longer in the FC's fleet.", kit);
  }
  if (doctrine.botIDs && !doctrine.botIDs.includes(positive(bot.characterID))) {
    return windDown(operation, bot, "The FC took this pilot off fleet duty.", kit);
  }
  operation.fleetID = Number(fleet.fleetID);
  const commander = readCommander(commanderID);
  if (!commander.online) {
    operation.commanderOfflineSinceMs ||= Date.now();
    if (Date.now() - operation.commanderOfflineSinceMs > FC_OFFLINE_GIVE_UP_MS) {
      return windDown(operation, bot, "The FC has been offline for 15 minutes.", kit);
    }
    setStage(operation, "waiting", "Waiting for the FC to come back online.", kit);
    return { delayMs: FC_OFFLINE_MS };
  }
  if (operation.commanderOfflineSinceMs) {
    delete operation.commanderOfflineSinceMs;
    kit.save(operation);
  }

  // Reading a pilot's space state attaches its ship to the scene it is in.
  // In the middle of a gate jump that would pull it back into the old
  // system, so a pilot already on a route to the FC is left to the route.
  const character = deps.characters().getCharacterRecord(bot.characterID) || {};
  const botSession = deps.space().getActorSession(bot);
  const botSystemID = positive(character.solarSystemID || botSession && (botSession.solarsystemid2 || botSession.solarsystemid));
  const onRoute = botSystemID !== commander.systemID && Boolean(operation.routeTaskID) &&
    positive(operation.routeDestinationSystemID) === commander.systemID;
  let stateCache = null;
  const spaceState = () => (stateCache ||= deps.space().getSpaceState(bot));

  // 1. The right ship.
  const fleetType = doctrine.fleetType;
  if (operation.fleetType !== fleetType) {
    operation.fleetType = fleetType;
    operation.fitCheckedAtMs = 0;
  }
  const fittingID = positive(doctrine.fits[fleetType]);
  if (!onRoute && operation.fitWaivedForType !== fleetType &&
      (!operation.fitCheckedAtMs || Date.now() - operation.fitCheckedAtMs > FIT_CHECK_MS)) {
    const fit = shipFitsJob(bot, fleetType, fittingID);
    operation.fitCheckedAtMs = Date.now();
    operation.fitNote = fit.reason;
    if (!fit.ok) {
      if (spaceState().inSpace && !spaceState().busy) {
        const attached = deps.space().getActorSpace(bot);
        stopLasers(bot);
        if (recallEverything(operation, attached, kit)) return { delayMs: STEP_MS };
      }
      operation.refitNeeded = { fleetType, fittingID };
      return kit.finish(operation, `${fit.reason} Fetching a ${describe(fleetType)} ship${fittingID ? ` (saved fitting ${fittingID})` : ""}, then rejoining the FC.`);
    }
    memberState(bot.characterID).refitAttempts = 0;
    kit.save(operation);
  }

  // 2. Same system as the FC.
  if (botSystemID !== commander.systemID) {
    // Before setting off: lasers off and drones home. Never mid-route.
    if (!onRoute && spaceState().inSpace && !spaceState().busy) {
      const attached = deps.space().getActorSpace(bot);
      stopLasers(bot);
      if (recallEverything(operation, attached, kit)) return { delayMs: STEP_MS };
    }
    if (positive(operation.routeDestinationSystemID) !== commander.systemID) {
      if (operation.routeTaskID && kit.clearRouteTask) kit.clearRouteTask(operation);
      operation.routeTaskID = null;
      operation.routeDestinationSystemID = commander.systemID;
    }
    setStage(operation, "travel", `Travelling to the FC in system ${commander.systemID}.`, kit);
    const step = await kit.travelToSystem(operation, bot, commander.systemID);
    return step || { delayMs: STEP_MS };
  }
  if (operation.routeTaskID || positive(operation.routeDestinationSystemID)) {
    if (operation.routeTaskID && kit.clearRouteTask) kit.clearRouteTask(operation);
    operation.routeTaskID = null;
    operation.routeDestinationSystemID = 0;
    kit.save(operation);
  }
  const state = spaceState();

  // 3. Dock and undock with the FC.
  const dockedStationID = positive(character.stationID || character.structureID);
  if (dockedStationID && operation.withdrawing) {
    await finishWithdrawal(operation, bot, kit);
    return { delayMs: 1_000 };
  }
  if (commander.stationID) {
    if (dockedStationID === commander.stationID) {
      delete operation.recallStartedAtMs;
      handOverWhileDocked(operation, bot, commander, kit);
      setStage(operation, "docked", "Docked with the FC; undocks when the FC does.", kit);
      return { delayMs: DOCKED_WATCH_MS };
    }
    if (state.inSpace) {
      const attached = deps.space().getActorSpace(bot);
      stopLasers(bot);
      if (recallEverything(operation, attached, kit)) return { delayMs: WARP_WAIT_MS };
      if (state.busy) return { delayMs: WARP_WAIT_MS };
    }
    setStage(operation, "to-station", `Docking at ${commander.stationID}, where the FC is.`, kit);
    const step = await kit.travelToStation(operation, bot, commander.stationID);
    return step || { delayMs: WARP_WAIT_MS };
  }
  if (!state.inSpace) {
    const undocked = deps.space().undock(bot, { allowOverCapacityDeparture: true });
    if (!undocked.success) {
      setStage(operation, "undocking", `Waiting to undock: ${String(undocked.message || "the station is busy").slice(0, 160)}`, kit);
      return { delayMs: undocked.capacityQueued ? STEP_MS : 15_000 };
    }
    setStage(operation, "undocking", "Undocked with the FC.", kit);
    return { delayMs: WARP_WAIT_MS };
  }
  if (state.busy) return { delayMs: WARP_WAIT_MS };

  const attached = deps.space().getActorSpace(bot);
  // A pilot about to lose its ship docks and repairs, then rejoins the FC.
  if (!operation.withdrawing && inDanger(state) && !(Number(operation.flyDamagedUntilMs) > Date.now())) {
    operation.withdrawing = true;
    operation.withdrawStationID = 0;
    kit.record(operation, `Badly damaged (shield ${Math.round(state.shield * 100)}%, armor ${Math.round((1 - state.armorDamage) * 100)}%, hull ${Math.round((1 - state.hullDamage) * 100)}%); withdrawing to repair.`);
    kit.save(operation);
  }
  if (operation.withdrawing) return withdraw(operation, bot, attached, kit);

  // 4. Follow the FC in warp.
  const fcEntity = attached.scene.getEntityByID(commander.shipID);
  if (!fcEntity) return { delayMs: WARP_WAIT_MS };
  if (fcEntity.mode === "WARP" || fcEntity.pendingWarp) {
    stopLasers(bot);
    recallEverything(operation, attached, kit);
    setStage(operation, "warping", "The FC is in warp; recalling drones to follow.", kit);
    return { delayMs: WARP_WAIT_MS };
  }
  const distance = state.distanceTo(commander.shipID);
  if (!Number.isFinite(distance)) return { delayMs: WARP_WAIT_MS };
  if (distance > WARP_RANGE_METERS) {
    stopLasers(bot);
    if (recallEverything(operation, attached, kit)) {
      setStage(operation, "warping", "Recalling drones to warp to the FC.", kit);
      return { delayMs: WARP_WAIT_MS };
    }
    const warp = deps.space().warp(bot, commander.shipID);
    if (!warp.success) {
      setStage(operation, "warping", `Cannot warp to the FC yet: ${String(warp.message || "warp refused").slice(0, 160)}`, kit);
      return { delayMs: warp.blocked ? 30_000 : STEP_MS };
    }
    setStage(operation, "warping", `Warping to the FC (${Math.round(distance / 1000).toLocaleString("en-US")} km).`, kit);
    return { delayMs: WARP_WAIT_MS };
  }

  // 5. Work the grid.
  const context = { operation, bot, kit, attached, state, commander, fcEntity, distance, fleet };
  if (operation.fitWaivedForType === fleetType) {
    keepNear(bot, attached, commander.shipID, FOLLOW_RANGE[fleetType]);
    setStage(operation, "following", `Following the FC without a ${describe(fleetType)} ship.`, kit);
    return { delayMs: STEP_MS };
  }
  if (fleetType === "mining") return workMining(context);
  if (fleetType === "hauling") return workHauling(context);
  return workCombat(context, fleetType === "escort");
}

// Losing the ship helps nobody: a pilot this badly hurt docks, repairs and
// then rejoins the FC.
function inDanger(state) {
  if (!state || !state.inSpace || state.isCapsule) return false;
  const shield = Number.isFinite(Number(state.shield)) ? Number(state.shield) : 1;
  const armorDamage = Number(state.armorDamage) || 0;
  const hullDamage = Number(state.hullDamage) || 0;
  return hullDamage > 0.2 || armorDamage > 0.6 || (shield < 0.15 && armorDamage > 0.25);
}

function nearestStation(bot) {
  try {
    const found = deps.combatRuntime().findNearestRepairStation(bot, 5, { excludeJita: true });
    if (found && found.success && positive(found.stationID)) return positive(found.stationID);
  } catch { /* local stations below */ }
  const character = deps.characters().getCharacterRecord(bot.characterID) || {};
  const world = deps.worldData();
  const stations = typeof world.getStationsForSystem === "function" ? world.getStationsForSystem(positive(character.solarSystemID)) || [] : [];
  return positive(stations[0] && (stations[0].stationID || stations[0].itemID));
}

async function withdraw(operation, bot, attached, kit) {
  stopLasers(bot);
  if (attached && recallEverything(operation, attached, kit)) {
    const shipID = positive(attached.entity.itemID);
    const out = controlledDrones(attached.scene, shipID).length + fightersInSpace(attached.scene, shipID).length;
    // Drones are worth less than the ship: wait a little, not the full recall time.
    if (out && Date.now() - (Number(operation.recallStartedAtMs) || Date.now()) < 8_000) return { delayMs: WARP_WAIT_MS };
  }
  if (!positive(operation.withdrawStationID)) {
    operation.withdrawStationID = nearestStation(bot);
    kit.save(operation);
  }
  if (!positive(operation.withdrawStationID)) {
    setStage(operation, "withdrawing", "Badly damaged and no station is in reach; staying with the FC.", kit);
    operation.withdrawing = false;
    kit.save(operation);
    return { delayMs: STEP_MS };
  }
  setStage(operation, "withdrawing", `Badly damaged; docking at ${operation.withdrawStationID} to repair.`, kit);
  const step = await kit.travelToStation(operation, bot, operation.withdrawStationID);
  if (step) return step;
  await finishWithdrawal(operation, bot, kit);
  return { delayMs: STEP_MS };
}

// Docked after withdrawing: repair, then rejoin. A ship that could not be
// repaired flies on damaged for ten minutes rather than bouncing in and out.
async function finishWithdrawal(operation, bot, kit) {
  const repaired = await repairDocked(bot);
  operation.withdrawing = false;
  operation.withdrawStationID = 0;
  if (!repaired.repaired) operation.flyDamagedUntilMs = Date.now() + 10 * 60 * 1000;
  else delete operation.flyDamagedUntilMs;
  kit.record(operation, repaired.message);
  kit.save(operation);
}

async function repairDocked(bot) {
  try {
    const session = deps.space().getActorSession(bot);
    const shipID = positive(session.shipID);
    const quote = require("../station/repairRuntime").buildRepairQuotesForSelection(session, [shipID]);
    if (!quote || !quote.success || !quote.data) return { repaired: false, message: "Docked; the station could not price repairs. Rejoining the FC." };
    const rows = quote.data.groupedQuotes.get(shipID) || [];
    const amount = Math.round(rows.reduce((total, row) =>
      total + Math.ceil(Number(row.damage) || 0) * (Number(row.costToRepairOneUnitOfDamage) || 0), 0) * 100) / 100;
    if (!(amount > 0)) return { repaired: false, message: "Docked; nothing to repair. Rejoining the FC." };
    const balance = Number(require("../account/walletState").getCharacterWallet(bot.characterID)?.balance) || 0;
    if (amount > balance) return { repaired: false, message: `Repairs cost ${amount.toFixed(0)} ISK, more than the pilot has. Rejoining the FC damaged.` };
    await new (require("../station/repairService"))().Handle_RepairItems([[shipID], amount], session);
    return { repaired: true, message: `Repaired for ${amount.toFixed(0)} ISK. Rejoining the FC.` };
  } catch (error) {
    return { repaired: false, message: `Repair failed (${String(error && error.message || error).slice(0, 120)}). Rejoining the FC.` };
  }
}

// Cargo a miner or hauler hands over while docked with the FC.
function handOverWhileDocked(operation, bot, commander, kit) {
  const filter = operation.fleetType === "hauling" ? () => true : operation.fleetType === "mining" ? isOre : null;
  if (!filter) return;
  if (!deps.inventory().listCargo(bot).some(filter)) return;
  const result = deliverToCommander(bot, commander, filter);
  if (result.moved) {
    kit.record(operation, `Put ${result.moved.toLocaleString("en-US")} unit(s) into the FC's fleet hangar.`);
    kit.save(operation);
  }
}

// ------------------------------------------------------------ mining

async function workMining(context) {
  const { operation, bot, kit, attached, commander } = context;
  const inventory = deps.inventory();
  const cargo = inventory.getCargoCapacity(bot);
  const full = cargo.capacity > 0 && cargo.used >= cargo.capacity * UNLOAD_AT_FILL;
  if (full || operation.unloading) return unloadOre(context, cargo);

  const { scene, entity, session } = attached;
  const operations = deps.operations();
  const lasers = typeof operations.getMiningModules === "function" ? operations.getMiningModules(bot) : [];
  let rockID = 0;
  if (lasers.length) {
    const isCurrent = () => {
      const latest = deps.operations().getOperation(bot.characterID);
      return Boolean(latest) && latest.operationID === operation.operationID && ["active", "holding"].includes(latest.status);
    };
    const result = await deps.space().mineNearestAsteroid(bot, lasers, 5_000, 0, { isCurrent });
    if (result && result.interrupted) return { delayMs: 1_000 };
    if (result && result.noOre) {
      keepNear(bot, attached, commander.shipID, FOLLOW_RANGE.mining);
      setStage(operation, "following", "No asteroids on this grid; staying with the FC.", kit);
      return { delayMs: STEP_MS };
    }
    rockID = positive(result && result.targetID) || activeLaserTarget(entity, lasers);
    if (result && result.success === false) {
      setStage(operation, "mining", `Mining is retrying: ${String(result.message || "").slice(0, 160)}`, kit);
      return { delayMs: STEP_MS };
    }
  }
  const miningDrones = droneStacks(bot, positive(entity.itemID), true);
  const outMiners = controlledDrones(scene, entity.itemID).filter((drone) => droneGroup(drone) === MINING_DRONE_GROUP);
  if (miningDrones.length || outMiners.length) {
    if (!rockID) rockID = nearestRock(attached);
    if (!rockID) {
      if (!lasers.length) {
        keepNear(bot, attached, commander.shipID, FOLLOW_RANGE.mining);
        setStage(operation, "following", "No asteroids on this grid; staying with the FC.", kit);
      }
      return { delayMs: STEP_MS };
    }
    if (!lasers.length) {
      const rock = scene.getEntityByID(rockID);
      if (distanceBetween(entity, rock) > 8_000) keepNear(bot, attached, rockID, 5_000);
    }
    let drones = outMiners;
    if (!drones.length || drones.length < MAX_LAUNCHED_DRONES && miningDrones.length) {
      launchDrones(session, miningDrones, MAX_LAUNCHED_DRONES - drones.length);
      drones = controlledDrones(scene, entity.itemID).filter((drone) => droneGroup(drone) === MINING_DRONE_GROUP);
    }
    const idle = drones.filter((drone) => positive(drone.targetID) !== rockID);
    if (idle.length) {
      try { deps.droneRuntime().commandMineRepeatedly(session, idle.map((drone) => Number(drone.itemID)), rockID); } catch { /* retried next step */ }
    }
  }
  setStage(operation, "mining", `Mining on the FC's grid; hold ${Math.round(cargo.used).toLocaleString("en-US")}/${Math.round(cargo.capacity).toLocaleString("en-US")} m³.`, kit);
  return { delayMs: STEP_MS };
}

function activeLaserTarget(entity, lasers) {
  const active = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : new Map();
  for (const module of lasers) {
    const effect = active.get(Number(module.itemID));
    if (effect && positive(effect.targetID)) return positive(effect.targetID);
  }
  return 0;
}

function nearestRock(attached) {
  const { scene, entity } = attached;
  try {
    const entries = require("../mining/miningNpcOperations")
      .resolveAvailableMineableTargetEntries(scene, null, entity, { localGridOnly: true })
      .filter((entry) => entry && entry.state && entry.state.yieldKind === "ore" && Number(entry.state.remainingQuantity) > 0);
    let best = null;
    let bestDistance = Infinity;
    for (const entry of entries) {
      const distance = distanceBetween(entity, entry.entity);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best ? positive(best.entity.itemID) : 0;
  } catch {
    return 0;
  }
}

function launchDrones(session, stacks, limit) {
  const requests = [];
  let remaining = Math.max(0, limit);
  for (const stack of stacks) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, deps.inventory().unitsOf(stack));
    if (amount > 0) {
      requests.push([Number(stack.itemID), amount]);
      remaining -= amount;
    }
  }
  if (!requests.length) return;
  try { deps.droneRuntime().launchDronesForSession(session, requests); } catch { /* bandwidth or bay limits; retried next step */ }
}

// Full hold: the FC's fleet hangar first, a jet can next to the FC second.
function unloadOre(context, cargo) {
  const { operation, bot, kit, attached, commander, distance } = context;
  if (!operation.unloading) {
    operation.unloading = true;
    kit.save(operation);
  }
  stopLasers(bot);
  const ore = deps.inventory().listCargo(bot).filter(isOre);
  if (!ore.length) {
    delete operation.unloading;
    kit.save(operation);
    return { delayMs: 1_000 };
  }
  if (distance > TRANSFER_RANGE_METERS) {
    keepNear(bot, attached, commander.shipID, 1_000);
    setStage(operation, "unloading", `Hold ${Math.round(cargo.used)}/${Math.round(cargo.capacity)} m³; flying to the FC to unload.`, kit);
    return { delayMs: STEP_MS };
  }
  const delivered = deliverToCommander(bot, commander, isOre);
  if (delivered.moved) {
    delete operation.unloading;
    kit.record(operation, `Unloaded ${delivered.moved.toLocaleString("en-US")} unit(s) of ore into the FC's fleet hangar.`);
    kit.save(operation);
    return { delayMs: 1_000 };
  }
  const why = {
    "no-hangar": "the FC's ship has no fleet hangar",
    "no-access": "the FC's fleet hangar does not allow fleet access",
    full: "the FC's fleet hangar is full",
  }[delivered.reason] || `the fleet hangar refused it (${delivered.error || delivered.reason})`;
  let result;
  try {
    result = require("../ship/jettisonRuntime").jettisonItemsForSession(attached.session, ore.map((item) => Number(item.itemID)));
  } catch (error) {
    result = { success: false, errorMsg: error.message };
  }
  if (result && result.success) {
    delete operation.unloading;
    kit.record(operation, `Jettisoned the ore into a jet can by the FC because ${why}.`);
    kit.save(operation);
    return { delayMs: 1_000 };
  }
  if (result && result.errorMsg === "JETTISON_COOLDOWN") {
    setStage(operation, "unloading", `Waiting to jettison (${why}).`, kit);
    return { delayMs: Math.min(30_000, Math.max(2_000, Number(result.retryAfterMs) || 5_000)) };
  }
  setStage(operation, "unloading", `Could not unload: ${why}; jettison failed (${String(result && result.errorMsg || "unknown").slice(0, 80)}).`, kit);
  return { delayMs: 15_000 };
}

// ------------------------------------------------------------ hauling

function fleetCansOnGrid(context) {
  const { attached, fleet } = context;
  const itemStore = deps.itemStore();
  const owners = new Set(memberIDs(fleet));
  return visibleEntities(attached)
    .filter((entity) => entity && entity.kind === "container" && isAlive(entity))
    .filter((entity) => {
      const item = itemStore.findItemById(positive(entity.itemID));
      return item && owners.has(positive(item.ownerID));
    })
    .sort((left, right) => distanceBetween(attached.entity, left) - distanceBetween(attached.entity, right));
}

function workHauling(context) {
  const { operation, bot, kit, attached, commander, distance } = context;
  const inventory = deps.inventory();
  const cargo = inventory.getCargoCapacity(bot);
  const hasCargo = inventory.listCargo(bot).length > 0;
  const hangar = fleetHangarInfo(commander.shipID, commander.shipTypeID);
  const canDeliver = hangar.capacity > 0 && hangar.fleetAccess && hangar.free > 1;
  const cans = cargo.free > cargo.capacity * (1 - UNLOAD_AT_FILL) ? fleetCansOnGrid(context) : [];

  if (cans.length) {
    const can = cans[0];
    const canDistance = distanceBetween(attached.entity, can);
    if (canDistance > CAN_PICKUP_RANGE_METERS) {
      keepNear(bot, attached, positive(can.itemID), 1_000);
      setStage(operation, "collecting", `Flying to a fleet jet can (${Math.round(canDistance / 1000)} km).`, kit);
      return { delayMs: STEP_MS };
    }
    const loaded = inventory.loadFromContainer(bot, positive(can.itemID));
    setStage(operation, "collecting", loaded.moved
      ? `Picked up ${loaded.moved.toLocaleString("en-US")} unit(s) from a fleet jet can.`
      : `Could not empty the jet can: ${String(loaded.error || "nothing moved").slice(0, 140)}`, kit);
    return { delayMs: 1_500 };
  }
  if (hasCargo && canDeliver) {
    if (distance > TRANSFER_RANGE_METERS) {
      keepNear(bot, attached, commander.shipID, 1_000);
      setStage(operation, "delivering", "Bringing the cargo to the FC.", kit);
      return { delayMs: STEP_MS };
    }
    const delivered = deliverToCommander(bot, commander, () => true);
    if (delivered.moved) {
      kit.record(operation, `Delivered ${delivered.moved.toLocaleString("en-US")} unit(s) to the FC's fleet hangar.`);
      kit.save(operation);
      return { delayMs: 1_000 };
    }
  }
  keepNear(bot, attached, commander.shipID, FOLLOW_RANGE.hauling);
  setStage(operation, "following", hasCargo
    ? `Holding ${Math.round(cargo.used).toLocaleString("en-US")} m³ for the FC${canDeliver ? "" : " until the FC's fleet hangar has room or the FC docks"}.`
    : "Staying with the FC and watching for fleet jet cans.", kit);
  return { delayMs: STEP_MS };
}

// ------------------------------------------------------------ combat

function commanderLockedTarget(commander) {
  try {
    const scene = require("../../space/runtime").getSceneForSession(commander.session);
    const ship = scene && scene.getShipEntityForSession(commander.session);
    if (!scene || !ship || typeof scene.getTargetsForEntity !== "function") return 0;
    const targets = scene.getTargetsForEntity(ship);
    return positive(Array.isArray(targets) && targets[targets.length - 1]);
  } catch {
    return 0;
  }
}

// FC's target first, then whoever is shooting this pilot, then the rat
// nearest the FC. Escorts only take rats close to the FC.
function chooseTarget(context, escort) {
  const { bot, attached, fcEntity } = context;
  const policy = deps.combatPolicy();
  const combat = deps.combatRuntime();
  const candidates = [commanderLockedTarget(context.commander), recentThreat(bot.characterID)].filter(Boolean);
  for (const id of candidates) {
    const entity = attached.scene.getEntityByID(id);
    if (!isAlive(entity) || distanceBetween(fcEntity, entity) > WARP_RANGE_METERS) continue;
    if (escort && distanceBetween(fcEntity, entity) > ESCORT_GUARD_RADIUS_METERS && id !== recentThreat(bot.characterID)) continue;
    if (policy.isPirateNpc(entity)) return entity;
    const allowed = combat.authorizeFleetAttackTarget(bot, entity, attached.scene);
    if (allowed && allowed.success) return entity;
  }
  const rats = visibleEntities(attached)
    .filter((entity) => isAlive(entity) && policy.isPirateNpc(entity))
    .filter((entity) => distanceBetween(fcEntity, entity) <= (escort ? ESCORT_GUARD_RADIUS_METERS : WARP_RANGE_METERS))
    .sort((left, right) => distanceBetween(fcEntity, left) - distanceBetween(fcEntity, right));
  return rats[0] || null;
}

// Drones need a pilot within their control range (20 km before skills).
function droneControlRange() {
  return DRONE_CONTROL_RANGE_METERS;
}

function workCombat(context, escort) {
  const { operation, bot, kit, attached, commander, state } = context;
  const { scene, entity, session } = attached;
  const shipID = positive(entity.itemID);
  const target = chooseTarget(context, escort);
  const combatDrones = () => controlledDrones(scene, shipID).filter((drone) => !NON_COMBAT_DRONE_GROUPS.has(droneGroup(drone)));
  if (!target) {
    const out = combatDrones();
    if (out.length) {
      if (!operation.idleSinceMs) {
        operation.idleSinceMs = Date.now();
        kit.save(operation);
      }
      if (Date.now() - operation.idleSinceMs > 20_000) {
        try { deps.droneRuntime().commandReturnBay(session, out.map((drone) => Number(drone.itemID))); } catch { /* next step */ }
      }
    }
    keepNear(bot, attached, commander.shipID, FOLLOW_RANGE[escort ? "escort" : "combat"]);
    setStage(operation, "following", escort ? "Guarding the FC; no rats close by." : "No rats on the FC's grid; staying with the FC.", kit);
    return { delayMs: STEP_MS };
  }
  if (operation.idleSinceMs) {
    delete operation.idleSinceMs;
    kit.save(operation);
  }
  const targetID = positive(target.itemID);
  const targetDistance = distanceBetween(entity, target);
  const lockRange = Math.max(5_000, Number(entity.maxTargetRange) || 30_000);
  // Guns and launchers set how close to fly; drones alone fight from further out.
  const gunRange = weaponReach(bot, shipID);
  const reach = gunRange
    ? Math.max(1_000, Math.min(lockRange * 0.85, gunRange))
    : Math.max(5_000, Math.min(lockRange * 0.85, droneControlRange() * 0.85));
  if (escort) {
    keepNear(bot, attached, commander.shipID, FOLLOW_RANGE.escort);
  } else if (targetDistance > reach) {
    keepNear(bot, attached, targetID, Math.max(1_000, Math.round(reach * (gunRange ? 0.8 : 0.6))));
  }
  if (targetDistance > lockRange) {
    setStage(operation, "engaging", `Closing on rat ${targetID} (${Math.round(targetDistance / 1000)} km).`, kit);
    return { delayMs: STEP_MS };
  }
  const locked = typeof scene.getTargetsForEntity === "function" &&
    scene.getTargetsForEntity(entity).map(Number).includes(targetID);
  if (!locked) {
    const result = deps.space().lockTarget(bot, targetID);
    setStage(operation, "engaging", result && result.success === false
      ? `Locking ${targetID} is retrying: ${String(result.errorMsg || result.message || "").slice(0, 120)}`
      : `Locking target ${targetID}.`, kit);
    return { delayMs: 2_000 };
  }

  // Drones.
  let drones = combatDrones();
  const bay = droneStacks(bot, shipID, false);
  if (drones.length < MAX_LAUNCHED_DRONES && bay.length && targetDistance <= droneControlRange()) {
    launchDrones(session, bay, MAX_LAUNCHED_DRONES - drones.length);
    drones = combatDrones();
  }
  const idle = drones.filter((drone) => positive(drone.targetID) !== targetID);
  if (idle.length) {
    try { deps.droneRuntime().commandEngage(session, idle.map((drone) => Number(drone.itemID)), targetID); } catch { /* retried */ }
  }
  // Fighters.
  const fighters = useFighters(bot, attached, targetID);
  // Guns and launchers.
  const weapons = fireWeapons(bot, attached, targetID);
  setStage(operation, "engaging", `Engaging ${String(target.itemName || target.name || "rat").slice(0, 60)} (${targetID}) with ${drones.length} drone(s)${fighters ? `, ${fighters} fighter squadron(s)` : ""}${weapons ? `, ${weapons} weapon(s)` : ""}.`, kit);
  void state;
  return { delayMs: 3_000 };
}

// The shortest useful range of the fitted guns and launchers (optimal plus
// half the falloff), or 0 when the ship has none.
function weaponReach(bot, shipID) {
  const fitting = deps.fitting();
  const items = deps.itemStore().listCharacterItems(bot.characterID, { locationID: shipID });
  let best = 0;
  for (const { item } of weaponModules(items)) {
    const optimal = Number(fitting.getTypeAttributeValue(positive(item.typeID), "maxRange")) || 0;
    const falloff = Number(fitting.getTypeAttributeValue(positive(item.typeID), "falloff")) || 0;
    const range = optimal + falloff / 2;
    if (range > 0) best = best ? Math.min(best, range) : range;
  }
  return best;
}

let dogma = null;
function fireWeapons(bot, attached, targetID) {
  const { entity, session } = attached;
  const shipID = positive(entity.itemID);
  const items = deps.itemStore().listCharacterItems(bot.characterID, { locationID: shipID });
  const weapons = weaponModules(items);
  if (!weapons.length) return 0;
  const active = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : new Map();
  if (!dogma) dogma = new (require("../dogma/dogmaService"))();
  let firing = 0;
  for (const { item, effect } of weapons) {
    const running = active.get(Number(item.itemID));
    if (running) {
      firing += 1;
      continue;
    }
    try {
      dogma.Handle_Activate([Number(item.itemID), effect, targetID, null], session);
      firing += 1;
    } catch { /* no ammo, out of range or cycling; retried next step */ }
  }
  return firing;
}

let fighterService = null;
function useFighters(bot, attached, targetID) {
  const { scene, entity, session } = attached;
  const shipID = positive(entity.itemID);
  const tubeCount = Math.min(FIGHTER_TUBE_FLAGS.length, Math.max(0, Math.trunc(Number(deps.fitting().getTypeAttributeValue(positive(entity.typeID), "fighterTubes")) || 0)));
  if (!tubeCount) return 0;
  const fighterRuntime = require("../fighter/fighterRuntime");
  const itemStore = deps.itemStore();
  const all = itemStore.listCharacterItems(bot.characterID, { locationID: shipID });
  const tubes = FIGHTER_TUBE_FLAGS.slice(0, tubeCount);
  const inSpace = fightersInSpace(scene, shipID);
  const busyTubes = new Set([
    ...inSpace.map((row) => row.tubeFlagID),
    ...all.filter((item) => tubes.includes(Number(item.flagID))).map((item) => Number(item.flagID)),
  ]);
  const bay = all.filter((item) => Number(item.flagID) === Number(itemStore.ITEM_FLAGS.FIGHTER_BAY));
  if (!fighterService) fighterService = new (require("../fighter/fighterMgrService"))();
  for (const tube of tubes) {
    if (busyTubes.has(tube) || !bay.length) continue;
    const stack = bay.shift();
    try {
      if (fighterService.Handle_LoadFightersToTube([Number(stack.itemID), tube], session, null)) busyTubes.add(tube);
    } catch { /* retried next step */ }
  }
  const launchedTubes = new Set(inSpace.map((row) => row.tubeFlagID));
  const ready = itemStore.listCharacterItems(bot.characterID, { locationID: shipID })
    .filter((item) => tubes.includes(Number(item.flagID)) && !launchedTubes.has(Number(item.flagID)))
    .map((item) => Number(item.flagID));
  if (ready.length) {
    try { fighterRuntime.launchFightersFromTubes(session, ready); } catch { /* retried */ }
  }
  const out = fightersInSpace(scene, shipID);
  if (out.length) {
    try { fighterRuntime.activateAbilitySlots(session, out.map((row) => row.itemID), 0, targetID); } catch { /* retried */ }
  }
  return out.length;
}

// ------------------------------------------------------- commands and view

function wake(characterID) {
  try {
    const result = require("./playerBotAutonomyRuntime").wakeIndustryCycleStep(positive(characterID));
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch { /* the duty's own timer picks the change up */ }
}

function fail(message, statusCode = 400) {
  return { success: false, message, statusCode };
}

function resolveCommanderFleet(commanderID) {
  const id = positive(commanderID);
  if (!id) return { error: fail("Choose a fleet commander.") };
  if (isBotID(id)) return { error: fail("Bots cannot command a fleet.") };
  return { id, fleet: fleetOfCommander(id) };
}

function toBotIDs(value) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(positive).filter(Boolean))].slice(0, 500);
  return ids.length ? ids : null;
}

function runCommand(body = {}) {
  const { id, fleet, error } = resolveCommanderFleet(body.commanderID);
  if (error) return error;
  const action = String(body.action || "").toLowerCase();
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const doctrine = { ...doctrineFor(id), fits: { ...doctrineFor(id).fits } };
  if (action === "set-type") {
    const type = String(args.fleetType || "").toLowerCase();
    if (!TYPE_KEYS.includes(type)) return fail("Choose mining, combat, hauling or escort.");
    doctrine.fleetType = type;
    saveDoctrine(doctrine);
    for (const botID of fleet ? selectedBots(doctrine, fleet) : []) memberState(botID).refitAttempts = 0;
    if (doctrine.active) ensureTimer();
    return { success: true, message: `This is now a ${FLEET_TYPES[type].label.toLowerCase()} fleet.${doctrine.active ? " The bots are switching over." : ""}`, doctrine };
  }
  if (action === "set-fit") {
    const type = String(args.fleetType || "").toLowerCase();
    if (!TYPE_KEYS.includes(type)) return fail("Choose which kind of fleet the fitting is for.");
    const fittingID = positive(args.fittingID);
    if (fittingID) {
      const saved = require("../../_secondary/fitting/fittingStore").findFittingByID(fittingID);
      if (!saved) return fail(`Saved fitting ${fittingID} was not found.`);
      const planned = require("./playerBotFitPlanner").buildFitPlan(saved);
      if (!planned || !planned.success) return fail(`That fitting cannot be used: ${planned && planned.message || "unknown problem"}`);
    }
    doctrine.fits[type] = fittingID;
    saveDoctrine(doctrine);
    for (const botID of fleet ? selectedBots(doctrine, fleet) : []) memberState(botID).refitAttempts = 0;
    return { success: true, message: fittingID ? `${FLEET_TYPES[type].label} fleets use saved fitting ${fittingID}.` : `${FLEET_TYPES[type].label} fleets use the built-in fit.`, doctrine };
  }
  if (action === "start") {
    if (!doctrine.fleetType) return fail("Choose what kind of fleet this is first.");
    if (!fleet) return fail("The commander is not leading a fleet right now.");
    doctrine.active = true;
    doctrine.botIDs = toBotIDs(args.botIDs);
    saveDoctrine(doctrine);
    for (const botID of selectedBots(doctrine, fleet)) {
      const state = memberState(botID);
      state.refitAttempts = 0;
      state.lastStartAtMs = 0;
    }
    ensureTimer();
    const count = selectedBots(doctrine, fleet).length;
    return { success: true, message: `${count} bot(s) are on ${describe(doctrine.fleetType)} duty with this FC.`, doctrine };
  }
  if (action === "stop") {
    const only = toBotIDs(args.botIDs);
    if (only && doctrine.active && fleet) {
      const remaining = selectedBots(doctrine, fleet).filter((botID) => !only.includes(botID));
      doctrine.botIDs = remaining.length ? remaining : null;
      doctrine.active = remaining.length > 0;
    } else {
      doctrine.active = false;
    }
    saveDoctrine(doctrine);
    const stopping = [];
    for (const operation of deps.operations().listActiveOperations ? deps.operations().listActiveOperations() : []) {
      if (operation.kind !== "fleet-duty" || positive(operation.commanderID) !== id) continue;
      if (only && !only.includes(positive(operation.characterID))) continue;
      // The duty sees the change on its next step; wake it so that is now.
      wake(operation.characterID);
      stopping.push(positive(operation.characterID));
    }
    reconcile();
    return { success: true, message: stopping.length ? `${stopping.length} bot(s) are recalling drones and going back to their own work.` : "Fleet duty is off.", doctrine };
  }
  if (action === "release-work") {
    // Stops whatever other work the fleet's bots are doing so they join now.
    if (!fleet) return fail("The commander is not leading a fleet right now.");
    let stopped = 0;
    for (const botID of selectedBots(doctrine, fleet)) {
      const current = deps.operations().getOperation(botID);
      if (!current || !["active", "holding"].includes(current.status) || current.kind === "fleet-duty") continue;
      if (["fit", "upgrade"].includes(current.kind) && positive(current.fleetDutyCommanderID) === id) continue;
      const result = deps.operations().stopOperation(current.characterName || String(botID));
      if (result && result.success) stopped += 1;
    }
    reconcile();
    return { success: true, message: stopped ? `Asked ${stopped} bot(s) to stop their own work and join the fleet.` : "No bot had other work to stop." };
  }
  return fail("Unknown fleet command.");
}

function listCommanderFittings(commanderID) {
  const rows = [];
  try {
    const store = require("../../_secondary/fitting/fittingStore");
    const character = deps.characters().getCharacterRecord(commanderID) || {};
    const owners = [positive(commanderID), positive(character.corporationID), positive(character.allianceID)].filter(Boolean);
    for (const ownerID of owners) {
      for (const fit of Object.values(store.getOwnerFittings(ownerID) || {})) {
        rows.push({
          fittingID: positive(fit.fittingID),
          name: String(fit.name || `Fitting ${fit.fittingID}`).slice(0, 80),
          shipTypeID: positive(fit.shipTypeID),
          shipTypeName: String(typeInfo(fit.shipTypeID)?.name || ""),
          owner: ownerID === positive(commanderID) ? "personal" : ownerID === positive(character.corporationID) ? "corporation" : "alliance",
        });
      }
    }
  } catch (error) {
    warn(`could not list fittings for ${commanderID}: ${error.message}`);
  }
  return rows.filter((row) => row.fittingID).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 300);
}

function locationOf(characterID, names) {
  const character = deps.characters().getCharacterRecord(characterID) || {};
  const session = deps.sessionRegistry().findSessionByCharacterID(characterID);
  const stationID = positive(session && (session.stationID || session.stationid || session.structureID || session.structureid) ||
    character.stationID || character.structureID);
  const systemID = positive(session && (session.solarsystemid2 || session.solarsystemid) || character.solarSystemID);
  const shipTypeID = positive(session && (session.shipTypeID || session.shiptypeid) || character.shipTypeID);
  return {
    online: Boolean(session),
    systemID,
    systemName: names.system(systemID),
    stationID,
    stationName: stationID ? names.station(stationID) : "",
    docked: Boolean(stationID),
    shipTypeID,
    shipTypeName: String(typeInfo(shipTypeID)?.name || ""),
    shipID: positive(session && (session.shipID || session.shipid) || character.shipID),
  };
}

function defaultNames() {
  const world = deps.worldData();
  return {
    system(systemID) {
      const system = positive(systemID) ? world.getSolarSystemByID(positive(systemID)) : null;
      return String(system && (system.solarSystemName || system.name) || "");
    },
    station(stationID) {
      let station = null;
      try { station = world.getStationByID(positive(stationID)); } catch { station = null; }
      return String(station && (station.stationName || station.itemName || station.name) || `Structure ${stationID}`);
    },
  };
}

// Every fleet with a person in it, its FC, the FC's settings and what each
// bot in it is doing.
function getOverview(options = {}) {
  loadDoctrines();
  const names = options.names || defaultNames();
  const fleetRuntime = deps.fleetRuntime();
  const fleetMap = fleetRuntime.runtimeState && fleetRuntime.runtimeState.fleets;
  const fleets = [];
  const operations = deps.operations();
  for (const fleet of fleetMap && typeof fleetMap.values === "function" ? fleetMap.values() : []) {
    const ids = memberIDs(fleet);
    if (!ids.length) continue;
    const commanderID = commanderOfFleet(fleet);
    if (!commanderID) continue;
    const doctrine = doctrineFor(commanderID);
    const commanderCharacter = deps.characters().getCharacterRecord(commanderID) || {};
    const commanderLocation = locationOf(commanderID, names);
    const hangar = fleetHangarInfo(commanderLocation.shipID, commanderLocation.shipTypeID);
    const chosen = doctrine.botIDs ? new Set(doctrine.botIDs) : null;
    const memberRows = ids.map((characterID) => {
      const bot = isBotID(characterID) ? getBot(characterID) : null;
      const location = locationOf(characterID, names);
      const row = {
        characterID,
        name: String(bot && bot.characterName || deps.characters().getCharacterRecord(characterID)?.characterName || `Pilot ${characterID}`),
        isBot: Boolean(bot),
        isCommander: characterID === commanderID,
        specialty: bot ? String(bot.specialty || "") : "",
        ...location,
      };
      if (bot) {
        const operation = operations.getOperation(characterID);
        const onDuty = Boolean(operation) && operation.kind === "fleet-duty" && positive(operation.commanderID) === commanderID &&
          ["active", "holding"].includes(operation.status);
        const state = members.get(characterID) || {};
        const refitting = Boolean(operation) && ["fit", "upgrade"].includes(operation.kind) &&
          positive(operation.fleetDutyCommanderID) === commanderID && ["active", "holding"].includes(operation.status);
        row.selected = !chosen || chosen.has(characterID);
        row.duty = {
          onDuty,
          stage: onDuty ? String(operation.stage || "") : "",
          lastAction: onDuty ? String(operation.lastAction || "") : "",
          fitNote: onDuty ? String(operation.fitNote || "") : "",
          withoutFit: Boolean(onDuty && operation.fitWaivedForType && operation.fitWaivedForType === operation.fleetType),
          refitting,
          currentWork: operation && ["active", "holding"].includes(operation.status) && !onDuty
            ? `${operation.kind} (${operation.stage || operation.status})` : "",
          note: String(state.note || ""),
          refitError: String(state.refitError || ""),
        };
      }
      return row;
    });
    fleets.push({
      fleetID: Number(fleet.fleetID) || 0,
      name: String(fleet.advert && fleet.advert.fleetName || `Fleet ${fleet.fleetID}`),
      commander: {
        characterID: commanderID,
        name: String(commanderCharacter.characterName || `Pilot ${commanderID}`),
        ...commanderLocation,
        fleetHangar: hangar,
      },
      doctrine: { ...doctrine, fits: { ...doctrine.fits } },
      botCount: memberRows.filter((row) => row.isBot).length,
      humanCount: memberRows.filter((row) => !row.isBot).length,
      members: memberRows.sort((left, right) => Number(right.isCommander) - Number(left.isCommander) ||
        Number(left.isBot) - Number(right.isBot) || left.name.localeCompare(right.name)),
      fittings: listCommanderFittings(commanderID),
    });
  }
  fleets.sort((left, right) => right.botCount - left.botCount || left.fleetID - right.fleetID);
  return {
    generatedAt: new Date().toISOString(),
    fleetTypes: TYPE_KEYS.map((key) => ({ key, label: FLEET_TYPES[key].label, summary: FLEET_TYPES[key].summary })),
    fleets,
  };
}

module.exports = {
  FLEET_TYPES,
  advanceFleetDuty,
  getDoctrine,
  enrolledIDs,
  getOverview,
  isEnrolled,
  noteIncomingThreat,
  reconcile,
  runCommand,
  shipFitsJob,
  _testing: {
    chooseTarget,
    commanderOfFleet,
    deliverToCommander,
    fleetHangarInfo,
    matchesSavedFit,
    memberState,
    normalizeDoctrine,
    readCommander,
    reconcileBot,
    deps,
    reset() {
      doctrines.clear();
      doctrinesLoaded = false;
      members.clear();
      threats.clear();
      enrolled = new Map();
      stopTimer();
    },
    setStore(store) {
      storeOverride = store;
    },
    stopTimer,
  },
};
