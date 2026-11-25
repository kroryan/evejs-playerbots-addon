"use strict";

// Fleet duty: the fleet commander's settings, how bots are called in, and
// what a bot on duty does at each step (dock, undock, warp, mine, fight,
// unload). Every game service is a small fake.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const SOURCE = path.resolve(__dirname, "../integration/server/server/src/services/playerbots/playerBotFleetCommandRuntime.js");

const FC = 900001;
const BOT = 800001;
const BOT2 = 800002;
const STATION = 60003760;
const SYSTEM = 30000142;
const FC_SHIP = 5001;
const BOT_SHIP = 5002;

function world(overrides = {}) {
  const calls = [];
  const log = (name, ...args) => calls.push([name, ...args]);
  const rows = new Map();
  const bots = new Map([
    [BOT, { characterID: BOT, characterName: "Zara Vex", specialty: "mining", status: "active" }],
    [BOT2, { characterID: BOT2, characterName: "Ilo Kade", specialty: "security", status: "active" }],
  ]);
  const fleet = {
    fleetID: 77,
    advert: { fleetName: "Rock Party" },
    members: new Map([[FC, { charID: FC }], [BOT, { charID: BOT }], [BOT2, { charID: BOT2 }]]),
  };
  const characters = new Map([
    [FC, { characterName: "Jess Commander", solarSystemID: SYSTEM, stationID: 0, shipID: FC_SHIP, shipTypeID: 28606, corporationID: 98000001 }],
    [BOT, { characterName: "Zara Vex", solarSystemID: SYSTEM, stationID: STATION, shipID: BOT_SHIP, shipTypeID: 32880 }],
    [BOT2, { characterName: "Ilo Kade", solarSystemID: SYSTEM, stationID: STATION, shipID: 5003, shipTypeID: 593 }],
  ]);
  const fcSession = {
    characterID: FC, solarsystemid2: SYSTEM, shipID: FC_SHIP, shipTypeID: 28606, _space: { shipID: FC_SHIP },
  };
  const botSession = { characterID: BOT, shipID: BOT_SHIP, solarsystemid2: SYSTEM, stationID: STATION };
  const operations = new Map();
  const items = [];
  const types = new Map([
    [10246, { typeID: 10246, name: "Mining Drone I", groupID: 101, categoryID: 18, volume: 5 }],
    [2454, { typeID: 2454, name: "Hobgoblin I", groupID: 100, categoryID: 18, volume: 5 }],
    [1230, { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, volume: 0.1 }],
    [28606, { typeID: 28606, name: "Orca", groupID: 941, categoryID: 6 }],
    [32880, { typeID: 32880, name: "Venture", groupID: 25, categoryID: 6 }],
  ]);
  const fcEntity = { kind: "ship", itemID: FC_SHIP, typeID: 28606, mode: "STOP", position: { x: 0, y: 0, z: 0 } };
  const botEntity = {
    kind: "ship", itemID: BOT_SHIP, typeID: 32880, mode: "STOP", position: { x: 3_000, y: 0, z: 0 },
    activeModuleEffects: new Map(), maxTargetRange: 40_000,
  };
  const rat = {
    kind: "ship", itemID: 7001, itemName: "Angel Raider", npcEntityType: "npc", warFactionID: 500011,
    position: { x: 12_000, y: 0, z: 0 },
  };
  const dynamicEntities = new Map([[FC_SHIP, fcEntity], [BOT_SHIP, botEntity]]);
  const visible = [];
  const locked = [];
  const scene = {
    systemID: SYSTEM,
    dynamicEntities,
    getEntityByID: (id) => dynamicEntities.get(Number(id)) || null,
    getVisibleEntitiesForSession: () => visible,
    getTargetsForEntity: (entity) => (entity === botEntity ? locked : []),
    getShipEntityForSession: () => fcEntity,
  };
  const state = { inSpace: false, busy: false };
  const fleetHangarItems = [];
  let fleetAccess = true;

  const services = {
    "../fleets/fleetRuntime": {
      runtimeState: { fleets: new Map([[77, fleet]]) },
      getBossCharacterID: () => FC,
      getMemberFleetForCharacter: (id) => (fleet.members.has(Number(id)) ? fleet : null),
    },
    "./playerBotRuntime": {
      hasBotProfile: (id) => bots.has(Number(id)),
      getBotByCharacterID: (id) => bots.get(Number(id)) || null,
      listBots: () => [...bots.values()],
    },
    "./playerBotOperationRuntime": {
      getOperation: (id) => (operations.has(id) ? structuredClone(operations.get(id)) : null),
      listActiveOperations: () => [...operations.values()].filter((op) => ["active", "holding"].includes(op.status)),
      stopOperation: (name) => { log("stopOperation", name); return { success: true }; },
      startFleetDuty: (name, commanderID, options) => { log("startFleetDuty", name, commanderID, options); return { success: true }; },
      startShipUpgrade: (name, role, options) => { log("startShipUpgrade", name, role, options); return { success: true, message: "buying" }; },
      startSavedFitting: (name, fittingID, requester, max, options) => { log("startSavedFitting", name, fittingID, requester.characterID, options); return { success: true, message: "fitting" }; },
      hasRoleShipFit: (bot, role) => (overrides.roleFits || []).includes(role),
      getMiningModules: () => (overrides.lasers === false ? [] : [{ itemID: 61 }]),
    },
    "../chat/sessionRegistry": {
      findSessionByCharacterID: (id) => (Number(id) === FC && overrides.fcOnline !== false ? fcSession : null),
    },
    "../character/characterState": { getCharacterRecord: (id) => characters.get(Number(id)) || null },
    "../inventory/itemStore": {
      ITEM_FLAGS: { DRONE_BAY: 87, FIGHTER_BAY: 158, CARGO_HOLD: 5 },
      listCharacterItems: (ownerID, filter = {}) => items.filter((item) => item.ownerID === ownerID &&
        (!filter.locationID || item.locationID === filter.locationID) && (!filter.flagID || item.flagID === filter.flagID)),
      listContainerItems: (_owner, locationID, flagID) => (locationID === FC_SHIP && flagID === 155 ? fleetHangarItems : []),
      findItemById: (id) => (Number(id) === FC_SHIP ? { itemID: FC_SHIP, shipConfiguration: { FleetHangar_AllowFleetAccess: fleetAccess } } : items.find((item) => item.itemID === Number(id)) || null),
    },
    "../inventory/itemTypeRegistry": { resolveItemByTypeID: (id) => types.get(Number(id)) || null },
    "../fitting/liveFittingState": {
      getTypeAttributeValue: (typeID, name) => (name === "fleetHangarCapacity" && Number(typeID) === 28606 ? 40_000 : null),
      isFittedModuleItem: (item) => item.flagID >= 11 && item.flagID <= 34,
    },
    "./playerBotInventoryRuntime": {
      getUnitVolume: (item) => types.get(item.typeID)?.volume || 1,
      unitsOf: (item) => Number(item.stacksize) || 1,
      listCargo: () => items.filter((item) => item.ownerID === BOT && item.locationID === BOT_SHIP && [5, 134].includes(item.flagID)),
      getCargoCapacity: () => overrides.cargo || { capacity: 5_000, used: 100, free: 4_900 },
      getCargoBayCapacity: () => 400,
      loadFromContainer: (bot, canID) => { log("loadFromContainer", canID); return { moved: 10 }; },
    },
    "./playerBotSpaceRuntime": {
      getSpaceState: () => (log("getSpaceState"), {
        ...state,
        distanceTo: (id) => {
          const target = scene.getEntityByID(id);
          if (!target) return null;
          return Math.hypot(target.position.x - botEntity.position.x, target.position.y - botEntity.position.y, target.position.z - botEntity.position.z);
        },
      }),
      getActorSession: () => botSession,
      getActorSpace: () => ({ scene, entity: botEntity, session: botSession }),
      undock: () => { log("undock"); return { success: true }; },
      warp: (bot, id) => { log("warp", id); return { success: true }; },
      approach: (bot, id, range) => { log("approach", id, range); return { success: true }; },
      lockTarget: (bot, id) => { log("lockTarget", id); locked.push(id); return { success: true }; },
      stopMining: () => log("stopMining"),
      mineNearestAsteroid: async () => { log("mine"); return { success: true, targetID: 9001 }; },
    },
    "./playerBotCombatPolicy": { isPirateNpc: (entity) => entity && entity.npcEntityType === "npc" },
    "./playerBotCombatRuntime": {
      authorizeFleetAttackTarget: () => ({ success: false }),
      findNearestRepairStation: () => ({ success: true, stationID: STATION }),
    },
    "../drone/droneRuntime": {
      launchDronesForSession: (session, requests) => {
        log("launchDrones", requests);
        for (const [itemID, qty] of requests) {
          const stack = items.find((item) => item.itemID === itemID);
          for (let index = 0; index < qty; index += 1) {
            const id = 9_100 + dynamicEntities.size;
            dynamicEntities.set(id, { kind: "drone", itemID: id, typeID: stack.typeID, controllerID: BOT_SHIP, targetID: null });
          }
        }
      },
      commandEngage: (session, ids, target) => { log("engage", ids.length, target); for (const id of ids) dynamicEntities.get(id).targetID = target; },
      commandMineRepeatedly: (session, ids, rock) => log("mineDrones", ids.length, rock),
      commandReturnBay: (session, ids) => { log("returnBay", ids.length); for (const id of ids) dynamicEntities.delete(id); },
    },
    "../../space/worldData": {
      getSolarSystemByID: () => ({ solarSystemName: "Jita" }),
      getStationByID: () => ({ stationName: "Jita IV - Moon 4" }),
    },
    "../../utils/logger": { warn: (message) => log("warn", message), info() {} },
    "../ship/shipServiceAccess": {
      normalizeShipConfiguration: (config) => ({ FleetHangar_AllowFleetAccess: config.FleetHangar_AllowFleetAccess === true }),
    },
    "../inventory/invBrokerService": class {
      Handle_GetInventoryFromId([id]) { log("bind", id); return { value: { value: [`bound-${id}`] } }; }
      Handle_Add([itemID, from], session, kwargs) {
        log("add", itemID, from, kwargs.flag, kwargs.qty);
        const index = items.findIndex((item) => item.itemID === itemID);
        if (index >= 0) fleetHangarItems.push(items.splice(index, 1)[0]);
      }
    },
    "../ship/jettisonRuntime": {
      jettisonItemsForSession: (session, ids) => { log("jettison", ids); return { success: true }; },
    },
    "../../space/runtime": { getSceneForSession: () => scene },
    "../../space/runtime/moduleActivationEffectRecord": { resolveDefaultActivationEffect: () => null },
    "../mining/miningNpcOperations": { resolveAvailableMineableTargetEntries: () => [] },
    "../../_secondary/fitting/fittingStore": {
      findFittingByID: (id) => (Number(id) === 4242 ? { fittingID: 4242, name: "Fleet Venture", shipTypeID: 32880 } : null),
      getOwnerFittings: (ownerID) => (ownerID === FC ? { 4242: { fittingID: 4242, name: "Fleet Venture", shipTypeID: 32880 } } : {}),
    },
    "../station/repairRuntime": {
      buildRepairQuotesForSelection: (session, [shipID]) => ({
        success: true,
        data: { groupedQuotes: new Map([[shipID, [{ damage: 100, costToRepairOneUnitOfDamage: 10 }]]]) },
      }),
    },
    "../account/walletState": { getCharacterWallet: () => ({ balance: overrides.wallet ?? 1_000_000 }) },
    "../station/repairService": class { async Handle_RepairItems(args) { log("repair", args[1]); } },
    "./playerBotFitPlanner": {
      buildFitPlan: () => ({ success: true, plan: { shipTypeID: 32880, moduleTypeIDs: [483, 483] } }),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), {
    module, Map, Set, Date, Math, Number, String, Object, Array, JSON, Promise, Error, structuredClone,
    setImmediate: () => {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    require(id) {
      if (!Object.hasOwn(services, id)) throw new Error(`Unexpected dependency: ${id}`);
      return services[id];
    },
  }, { filename: SOURCE });
  const runtime = module.exports;
  runtime._testing.setStore({
    ensureTable() {},
    read(table, key) {
      if (key === "/") return { success: true, data: Object.fromEntries(rows) };
      return { success: true, data: rows.get(key.slice(1)) };
    },
    write(table, key, value) { rows.set(key.slice(1), structuredClone(value)); return { success: true }; },
    flushTableSync() { return { success: true }; },
  });
  const kit = {
    record(operation, message) { operation.lastAction = message; log("record", message); },
    save(operation) { operations.set(operation.characterID, structuredClone(operation)); },
    finish(operation, message) { operation.status = "completed"; operation.lastAction = message; operations.set(operation.characterID, structuredClone(operation)); log("finish", message); return { done: true }; },
    travelToSystem: async (operation, bot, systemID) => { log("travelToSystem", systemID); return { delayMs: 5_000 }; },
    travelToStation: async (operation, bot, stationID) => { log("travelToStation", stationID); return { delayMs: 5_000 }; },
    clearRouteTask() {},
  };
  const duty = (fields = {}) => ({
    operationID: "OP1", kind: "fleet-duty", characterID: BOT, characterName: "Zara Vex",
    status: "active", stage: "muster", commanderID: FC, fleetType: "mining", fitCheckedAtMs: 0, ...fields,
  });
  const bot = bots.get(BOT);
  return {
    runtime, calls, rows, bots, fleet, characters, fcSession, botSession, operations, items, fcEntity, botEntity, rat,
    dynamicEntities, visible, locked, state, fleetHangarItems, kit, duty, bot, scene,
    setFleetAccess(value) { fleetAccess = value; },
    // Values made inside the sandbox have its own Array and Object; copy
    // them out so deepEqual compares structure only.
    names: (name) => plain(calls.filter((call) => call[0] === name)),
    async step(operation = duty()) {
      operations.set(operation.characterID, structuredClone(operation));
      const result = await runtime.advanceFleetDuty(operation, bot, kit);
      return { result: plain(result), operation: plain(operation) };
    },
  };
}

function enableDuty(w, fleetType = "mining") {
  assert.equal(w.runtime.runCommand({ commanderID: FC, action: "set-type", args: { fleetType } }).success, true);
  assert.equal(w.runtime.runCommand({ commanderID: FC, action: "start", args: {} }).success, true);
}

test("the FC's fleet settings are saved per commander and checked", () => {
  const w = world();
  assert.match(w.runtime.runCommand({ commanderID: FC, action: "start" }).message, /what kind of fleet/);
  assert.match(w.runtime.runCommand({ commanderID: FC, action: "set-type", args: { fleetType: "pirating" } }).message, /mining, combat, hauling or escort/);
  assert.match(w.runtime.runCommand({ commanderID: BOT, action: "set-type", args: { fleetType: "mining" } }).message, /Bots cannot command/);
  assert.match(w.runtime.runCommand({ commanderID: FC, action: "set-fit", args: { fleetType: "mining", fittingID: 1 } }).message, /not found/);
  assert.equal(w.runtime.runCommand({ commanderID: FC, action: "set-fit", args: { fleetType: "mining", fittingID: 4242 } }).success, true);
  enableDuty(w, "mining");
  const stored = plain(w.rows.get(`_playerBotFleetDoctrine_${FC}`).playerBotFleetDoctrine);
  assert.equal(stored.fleetType, "mining");
  assert.equal(stored.active, true);
  assert.equal(stored.fits.mining, 4242);
  assert.equal(stored.botIDs, null);
  assert.equal(w.runtime.isEnrolled(BOT), false, "enrolment is settled by the next reconcile");
  w.runtime.reconcile();
  assert.equal(w.runtime.isEnrolled(BOT), true);
  assert.equal(w.runtime.isEnrolled(BOT2), true);
  assert.equal(w.runtime.isEnrolled(FC), false);
});

test("a person, never a bot, is the fleet commander", () => {
  const w = world();
  assert.equal(w.runtime._testing.commanderOfFleet(w.fleet), FC);
  const services = w.runtime._testing.deps.fleetRuntime();
  services.getBossCharacterID = () => BOT;
  assert.equal(w.runtime._testing.commanderOfFleet(w.fleet), FC, "a bot boss hands command to the first person");
});

test("idle bots report for duty; mining bots stop; busy bots finish first", () => {
  const w = world();
  enableDuty(w, "mining");
  w.operations.set(BOT2, { operationID: "OPX", kind: "haul", stage: "to-source", status: "active", characterID: BOT2 });
  w.runtime.reconcile();
  assert.deepEqual(w.names("startFleetDuty").map((call) => call[1]), ["Zara Vex"]);
  assert.match(w.runtime._testing.memberState(BOT2).note, /Finishing its own haul work/);

  w.operations.set(BOT2, { operationID: "OPY", kind: "mine", stage: "mining", status: "active", characterID: BOT2 });
  w.runtime.reconcile();
  assert.deepEqual(w.names("stopOperation").map((call) => call[1]), ["Ilo Kade"]);

  const released = w.runtime.runCommand({ commanderID: FC, action: "release-work" });
  assert.equal(released.success, true);
});

test("only the chosen bots go on duty", () => {
  const w = world();
  w.runtime.runCommand({ commanderID: FC, action: "set-type", args: { fleetType: "combat" } });
  w.runtime.runCommand({ commanderID: FC, action: "start", args: { botIDs: [BOT2] } });
  w.runtime.reconcile();
  assert.equal(w.runtime.isEnrolled(BOT), false);
  assert.equal(w.runtime.isEnrolled(BOT2), true);
  assert.deepEqual(w.names("startFleetDuty").map((call) => call[1]), ["Ilo Kade"]);
});

test("a bot without the right ship fetches one, then follows without working if that fails", () => {
  const w = world();
  enableDuty(w, "combat");
  w.bots.delete(BOT2);
  w.fleet.members.delete(BOT2);
  w.operations.set(BOT, { operationID: "OPD", kind: "fleet-duty", status: "completed", commanderID: FC, characterID: BOT, refitNeeded: { fleetType: "combat" } });
  w.runtime.reconcile();
  const upgrade = w.names("startShipUpgrade")[0];
  assert.equal(upgrade[2], "security");
  assert.equal(upgrade[3].fleetDutyCommanderID, FC);

  // A saved fitting for the fleet type is used instead of the built-in fit.
  w.runtime.runCommand({ commanderID: FC, action: "set-fit", args: { fleetType: "combat", fittingID: 4242 } });
  w.runtime._testing.memberState(BOT).lastStartAtMs = 0;
  w.operations.set(BOT, { operationID: "OPE", kind: "fleet-duty", status: "completed", commanderID: FC, characterID: BOT, refitNeeded: { fleetType: "combat" } });
  w.runtime.reconcile();
  assert.deepEqual(w.names("startSavedFitting")[0].slice(1, 4), ["Zara Vex", 4242, FC]);

  // Out of attempts: it rejoins the FC and only follows.
  for (const id of ["OPF", "OPG"]) {
    w.runtime._testing.memberState(BOT).lastStartAtMs = 0;
    w.operations.set(BOT, { operationID: id, kind: "fleet-duty", status: "completed", commanderID: FC, characterID: BOT, refitNeeded: { fleetType: "combat" } });
    w.runtime.reconcile();
  }
  const started = w.names("startFleetDuty").at(-1);
  assert.equal(started[3].fitWaivedForType, "combat");
});

test("a docked bot waits with a docked FC and hands its ore over", async () => {
  const w = world();
  enableDuty(w, "mining");
  w.fcSession.stationID = STATION;
  delete w.fcSession._space;
  w.items.push(
    { itemID: 51, ownerID: BOT, locationID: BOT_SHIP, flagID: 134, typeID: 1230, stacksize: 1_000 },
    { itemID: 52, ownerID: BOT, locationID: BOT_SHIP, flagID: 27, typeID: 483 },
    { itemID: 53, ownerID: BOT, locationID: BOT_SHIP, flagID: 27, typeID: 483 },
  );
  const { result, operation } = await w.step();
  assert.equal(result.delayMs, 3_000);
  assert.equal(operation.stage, "docked");
  const add = w.names("add")[0];
  assert.deepEqual(add.slice(1), [51, BOT_SHIP, 155, 1_000]);
  assert.equal(w.names("bind")[0][1], FC_SHIP, "the transfer goes into the FC's ship");
});

test("the bot undocks when the FC undocks and warps to the FC once the FC lands", async () => {
  const w = world();
  enableDuty(w, "mining");
  let step = await w.step();
  assert.equal(w.names("undock").length, 1);
  assert.equal(step.operation.stage, "undocking");

  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.fcEntity.mode = "WARP";
  step = await w.step(step.operation);
  assert.equal(step.operation.stage, "warping");
  assert.equal(w.names("warp").length, 0, "no warp while the FC is still in warp");

  w.fcEntity.mode = "STOP";
  w.fcEntity.position = { x: 3_000_000, y: 0, z: 0 };
  step = await w.step(step.operation);
  assert.deepEqual(w.names("warp")[0], ["warp", FC_SHIP]);
});

test("a pilot on its route to the FC is left alone mid-jump", async () => {
  const w = world();
  enableDuty(w, "mining");
  w.characters.get(BOT).solarSystemID = 30002524;
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.state.busy = true;
  const step = await w.step(w.duty({ routeTaskID: "PB1", routeDestinationSystemID: SYSTEM, fitCheckedAtMs: 0 }));
  assert.equal(w.names("getSpaceState").length, 0, "reading space state would re-attach the ship to the old system");
  assert.deepEqual(w.names("travelToSystem")[0], ["travelToSystem", SYSTEM]);
  assert.equal(step.operation.stage, "travel");
});

test("drones come home before the bot warps after the FC", async () => {
  const w = world();
  enableDuty(w, "mining");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.dynamicEntities.set(9500, { kind: "drone", itemID: 9500, typeID: 10246, controllerID: BOT_SHIP });
  w.fcEntity.position = { x: 3_000_000, y: 0, z: 0 };
  let step = await w.step();
  assert.equal(w.names("returnBay").length, 1);
  assert.equal(w.names("warp").length, 0);
  step = await w.step(step.operation);
  assert.equal(w.names("warp").length, 1);
});

test("on the FC's grid a miner mines with lasers and drones", async () => {
  const w = world();
  enableDuty(w, "mining");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.items.push({ itemID: 71, ownerID: BOT, locationID: BOT_SHIP, flagID: 87, typeID: 10246, stacksize: 2 });
  const { operation } = await w.step();
  assert.equal(operation.stage, "mining");
  assert.equal(w.names("mine").length, 1);
  assert.deepEqual(w.names("launchDrones")[0][1], [[71, 2]]);
  assert.deepEqual(w.names("mineDrones")[0].slice(1), [2, 9001]);
});

test("a full miner unloads into the FC's fleet hangar, or a jet can without access", async () => {
  const w = world({ cargo: { capacity: 5_000, used: 4_800, free: 200 } });
  enableDuty(w, "mining");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.items.push({ itemID: 51, ownerID: BOT, locationID: BOT_SHIP, flagID: 134, typeID: 1230, stacksize: 48_000 });
  let step = await w.step();
  assert.deepEqual(w.names("approach")[0].slice(1), [FC_SHIP, 1_000], "it flies to the FC first");
  assert.equal(step.operation.stage, "unloading");
  w.botEntity.position = { x: 1_500, y: 0, z: 0 };
  step = await w.step(step.operation);
  assert.deepEqual(w.names("add")[0].slice(1), [51, BOT_SHIP, 155, 48_000]);
  assert.equal(w.names("jettison").length, 0);

  w.items.push({ itemID: 52, ownerID: BOT, locationID: BOT_SHIP, flagID: 134, typeID: 1230, stacksize: 100 });
  w.setFleetAccess(false);
  step = await w.step(step.operation);
  assert.deepEqual(w.names("jettison")[0][1], [52]);
  assert.match(w.names("record").at(-1)[1], /does not allow fleet access/);
});

test("combat bots lock the rat nearest the FC and send drones", async () => {
  const w = world({ roleFits: ["security"] });
  enableDuty(w, "combat");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.visible.push(w.rat);
  w.dynamicEntities.set(w.rat.itemID, w.rat);
  w.items.push({ itemID: 72, ownerID: BOT, locationID: BOT_SHIP, flagID: 87, typeID: 2454, stacksize: 5 });
  let step = await w.step(w.duty({ fleetType: "combat" }));
  assert.deepEqual(w.names("lockTarget")[0], ["lockTarget", w.rat.itemID]);
  step = await w.step(step.operation);
  assert.deepEqual(w.names("launchDrones")[0][1], [[72, 5]]);
  assert.deepEqual(w.names("engage")[0].slice(1), [5, w.rat.itemID]);
  assert.equal(step.operation.stage, "engaging");
});

test("a badly damaged pilot stops fighting, docks to repair, then rejoins", async () => {
  const w = world({ roleFits: ["security"] });
  enableDuty(w, "combat");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.state.shield = 0.05;
  w.state.armorDamage = 0.7;
  w.visible.push(w.rat);
  w.dynamicEntities.set(w.rat.itemID, w.rat);
  const step = await w.step(w.duty({ fleetType: "combat" }));
  assert.equal(step.operation.withdrawing, true);
  assert.equal(step.operation.stage, "withdrawing");
  assert.deepEqual(w.names("travelToStation")[0], ["travelToStation", STATION]);
  assert.equal(w.names("lockTarget").length, 0, "it does not keep fighting");
});

test("once docked, a withdrawn pilot repairs; without the ISK it flies on damaged", async () => {
  const w = world();
  enableDuty(w, "mining");
  let step = await w.step(w.duty({ withdrawing: true, withdrawStationID: STATION }));
  assert.deepEqual(w.names("repair")[0], ["repair", 1_000]);
  assert.equal(step.operation.withdrawing, false);
  assert.match(w.names("record").at(-1)[1], /Repaired for 1000 ISK/);

  const poor = world({ wallet: 10 });
  enableDuty(poor, "mining");
  step = await poor.step(poor.duty({ withdrawing: true, withdrawStationID: STATION }));
  assert.equal(poor.names("repair").length, 0);
  assert.ok(step.operation.flyDamagedUntilMs > Date.now(), "it will not bounce straight back to the station");
});

test("haulers empty the fleet's jet cans and bring the cargo to the FC", async () => {
  const w = world({ roleFits: ["logistics"], cargo: { capacity: 5_000, used: 0, free: 5_000 } });
  enableDuty(w, "hauling");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  const can = { kind: "container", itemID: 8801, position: { x: 9_000, y: 0, z: 0 } };
  const stranger = { kind: "container", itemID: 8802, position: { x: 3_500, y: 0, z: 0 } };
  w.items.push({ itemID: 8801, ownerID: BOT2 }, { itemID: 8802, ownerID: 123 });
  w.visible.push(stranger, can);
  w.dynamicEntities.set(8801, can);
  let step = await w.step(w.duty({ fleetType: "hauling" }));
  assert.deepEqual(w.names("approach")[0].slice(1), [8801, 1_000], "only fleet members' cans, nearest first");
  can.position = { x: 4_000, y: 0, z: 0 };
  step = await w.step(step.operation);
  assert.deepEqual(w.names("loadFromContainer")[0], ["loadFromContainer", 8801]);

  w.visible.length = 0;
  w.items.push({ itemID: 61, ownerID: BOT, locationID: BOT_SHIP, flagID: 5, typeID: 1230, stacksize: 500 });
  w.botEntity.position = { x: 1_000, y: 0, z: 0 };
  step = await w.step(step.operation);
  assert.deepEqual(w.names("add")[0].slice(1), [61, BOT_SHIP, 155, 500]);
});

test("standing the fleet down, or leaving the fleet, ends the duty after drones return", async () => {
  const w = world();
  enableDuty(w, "mining");
  w.characters.get(BOT).stationID = 0;
  w.state.inSpace = true;
  w.dynamicEntities.set(9500, { kind: "drone", itemID: 9500, typeID: 10246, controllerID: BOT_SHIP });
  w.operations.set(BOT, w.duty());
  assert.equal(w.runtime.runCommand({ commanderID: FC, action: "stop" }).success, true);
  let step = await w.step();
  assert.equal(step.operation.stage, "leaving");
  step = await w.step(step.operation);
  assert.equal(step.result.done, true);
  assert.match(w.names("finish")[0][1], /stood the fleet down/);

  const again = world();
  enableDuty(again, "mining");
  again.fleet.members.delete(BOT);
  const left = await again.step();
  assert.equal(left.result.done, true);
  assert.match(again.names("finish")[0][1], /no longer in the FC's fleet/);
});

test("a bot without a working ship hands over to a refit", async () => {
  const w = world({ lasers: false });
  enableDuty(w, "mining");
  const { result, operation } = await w.step();
  assert.equal(result.done, true);
  assert.deepEqual(operation.refitNeeded, { fleetType: "mining", fittingID: 0 });
});

test("the overview lists the fleet, its FC, the fleet hangar and each bot's duty", () => {
  const w = world();
  enableDuty(w, "mining");
  w.operations.set(BOT, w.duty({ stage: "mining", lastAction: "Mining on the FC's grid." }));
  const overview = plain(w.runtime.getOverview());
  assert.deepEqual(overview.fleetTypes.map((type) => type.key), ["mining", "combat", "hauling", "escort"]);
  const [fleet] = overview.fleets;
  assert.equal(fleet.commander.name, "Jess Commander");
  assert.equal(fleet.commander.fleetHangar.capacity, 40_000);
  assert.equal(fleet.commander.fleetHangar.fleetAccess, true);
  assert.equal(fleet.botCount, 2);
  assert.equal(fleet.members[0].isCommander, true);
  const zara = fleet.members.find((member) => member.characterID === BOT);
  assert.equal(zara.duty.onDuty, true);
  assert.equal(zara.duty.stage, "mining");
  assert.deepEqual(fleet.fittings.map((fit) => fit.fittingID), [4242]);

  // A bot fetching a ship for this fleet is shown as such, not as busy elsewhere.
  w.operations.set(BOT2, { operationID: "OPU", kind: "upgrade", stage: "buy", status: "active", characterID: BOT2, fleetDutyCommanderID: FC });
  const ilo = plain(w.runtime.getOverview()).fleets[0].members.find((member) => member.characterID === BOT2);
  assert.equal(ilo.duty.refitting, true);
});

test("the add-on API and the dashboard server pass fleet orders through", async (t) => {
  const { createPlayerBotAddonApiRuntime } = require("../integration/server/server/src/services/playerbots/playerBotAddonApiRuntime");
  const { createDashboardServer } = require("../addons/playerbots/dashboard-server");
  const received = [];
  const fleetCommand = {
    getOverview: () => ({ fleets: [{ fleetID: 77 }], fleetTypes: [] }),
    runCommand: (body) => { received.push(body); return { success: true, message: "ok" }; },
  };
  const token = "fleet-duty-test-token-".repeat(2);
  const api = createPlayerBotAddonApiRuntime({
    host: "127.0.0.1", port: 0, token, fleetCommand, corporationLogos: {},
    playerBots: {}, autonomy: {}, dashboard: {}, configuration: { getSettings: () => ({}) }, director: {},
    logger: { info() {}, warn() {} }, telemetry: { start() {}, stop() {}, recordWork() {} },
  });
  t.after(() => api.shutdown());
  await api.start();
  const apiURL = `http://127.0.0.1:${api.getDiagnostics().port}`;
  const dashboard = createDashboardServer({ host: "127.0.0.1", port: 0, token, apiURL });
  await dashboard.start();
  t.after(() => dashboard.shutdown());
  const url = `http://127.0.0.1:${dashboard.getDiagnostics().port}`;

  assert.equal((await fetch(`${apiURL}/v1/dashboard/fleets`)).status, 401);
  const overview = await (await fetch(`${url}/api/fleets`)).json();
  assert.equal(overview.fleets[0].fleetID, 77);
  const post = (body, origin = url) => fetch(`${url}/api/fleet-command`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  assert.equal((await post({ commanderID: FC, action: "start" }, "http://elsewhere.invalid")).status, 403);
  const accepted = await post({ commanderID: FC, action: "set-type", args: { fleetType: "mining" }, extra: "dropped" });
  assert.equal(accepted.status, 200);
  assert.deepEqual(received, [{ commanderID: FC, action: "set-type", args: { fleetType: "mining" } }]);
});
