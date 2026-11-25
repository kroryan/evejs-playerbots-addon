"use strict";

// Home base: bots of a corporation with a headquarters work around it and
// fly home between jobs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = path.resolve(__dirname, "../integration/server/server/src/services/playerbots/playerBotHomeBaseRuntime.js");
const CORP = 98000010;
const HQ = 1_035_000_000_001;
const HQ_SYSTEM = 30002505;
const NEAR_SYSTEM = 30002506;
const FAR_SYSTEM = 30002510;

function load(overrides = {}) {
  const characters = new Map([
    [1, { corporationID: CORP, solarSystemID: FAR_SYSTEM, stationID: 60_000_001 }],
    [2, { corporationID: CORP, solarSystemID: NEAR_SYSTEM, stationID: 60_000_002 }],
    [3, { corporationID: CORP, solarSystemID: FAR_SYSTEM, stationID: 0 }],
  ]);
  const hops = { [`${FAR_SYSTEM}:${HQ_SYSTEM}`]: 9, [`${NEAR_SYSTEM}:${HQ_SYSTEM}`]: 2 };
  const structure = {
    structureID: HQ, solarSystemID: HQ_SYSTEM, itemName: "Hulm - Home Sweet Home", ownerCorpID: CORP,
    hasQuantumCore: overrides.quantumCore !== false,
    devFlags: { playerBotCorporationHeadquarters: true, playerBotHeadquartersCorporationID: CORP },
  };
  const services = {
    "../character/characterState": { getCharacterRecord: (id) => characters.get(Number(id)) || null },
    "../structure/structureState": {
      getStructureByID: (id) => (Number(id) === HQ ? structure : null),
      listOwnedStructures: (corporationID) => (corporationID === CORP && overrides.noStructure !== true ? [structure] : []),
      isDockingServiceOnline: () => overrides.docking !== false,
    },
    "../../space/worldData": {
      getStationByID: (id) => (Number(id) === 60_009_999 ? { stationName: "Saved HQ Station", solarSystemID: NEAR_SYSTEM } : null),
      getSolarSystemByID: (id) => ({ security: Number(id) === HQ_SYSTEM ? (overrides.hqSecurity ?? 0.9) : 0.9 }),
      getAsteroidBeltsForSystem: (id) => (Number(id) === HQ_SYSTEM && overrides.hqBelts === false ? [] : [{ itemID: 1 }]),
    },
    "./playerBotCorpCommands": {
      getSavedHeadquartersID: () => overrides.savedID || 0,
      getHeadquarters: () => (overrides.savedID ? { stationID: overrides.savedID, kind: "station" } : { error: "none" }),
    },
    "./playerBotSpaceRuntime": {
      findStargateRoute: (from, to) => {
        const count = hops[`${from}:${to}`];
        return count === undefined ? { success: false } : { success: true, gates: Array(count).fill(0) };
      },
    },
    "./playerBotOperationRuntime": {
      findNearestMiningStation: (systemID, security, maxHops) => (maxHops >= 1 ? { systemID: NEAR_SYSTEM, stationID: 60_000_002 } : null),
    },
    "./playerBotConfigurationRuntime": { getSettings: () => ({ homeRangeJumps: overrides.range ?? 5 }) },
    "./playerBotEconomyRuntime": { JITA_SYSTEM_ID: 30000142 },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), {
    module, Map, Set, Date, Math, Number, String, Object, Array, JSON,
    require(id) {
      if (!Object.hasOwn(services, id)) throw new Error(`Unexpected dependency: ${id}`);
      return services[id];
    },
  }, { filename: SOURCE });
  return { runtime: module.exports, characters };
}

const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

test("home is the Upwell HQ structure; a saved NPC station only without one", () => {
  assert.equal(load().runtime.getHomeBase(CORP).stationID, HQ);
  assert.equal(load().runtime.getHomeBase(CORP).source, "structure");
  const savedStructure = load({ savedID: HQ }).runtime.getHomeBase(CORP);
  assert.deepEqual([savedStructure.stationID, savedStructure.kind, savedStructure.source], [HQ, "structure", "saved"]);
  const stationWithStructure = load({ savedID: 60_009_999 }).runtime.getHomeBase(CORP);
  assert.deepEqual([stationWithStructure.stationID, stationWithStructure.source], [HQ, "structure"], "the structure outranks a saved NPC station");
  const stationOnly = load({ savedID: 60_009_999, noStructure: true }).runtime.getHomeBase(CORP);
  assert.deepEqual([stationOnly.stationID, stationOnly.source], [60_009_999, "saved"]);
  assert.equal(load({ noStructure: true }).runtime.getHomeBase(CORP), null, "no HQ: no home, bots roam");
  assert.equal(load({ docking: false }).runtime.getHomeBase(CORP), null, "an HQ nobody can dock at is no home");
});

test("a docked pilot far from home flies home between jobs; nearby, roaming or undocked ones do not", () => {
  const { runtime } = load();
  assert.deepEqual(plain(runtime.chooseReturnHome({ characterID: 1, specialty: "mining" })),
    { kind: "relocate", stationID: HQ, home: true, hops: 9 });
  assert.equal(runtime.chooseReturnHome({ characterID: 2, specialty: "mining" }), null, "two jumps is home already");
  assert.equal(runtime.chooseReturnHome({ characterID: 1, specialty: "trade" }), null, "traders follow the markets");
  assert.equal(runtime.chooseReturnHome({ characterID: 3, specialty: "security" }), null, "only docked pilots between jobs");
  assert.equal(load({ range: 0 }).runtime.chooseReturnHome({ characterID: 1, specialty: "mining" }), null, "range 0 turns it off");
});

test("miners work from the HQ when it can be a mining home, else the nearest belt station", () => {
  assert.equal(load().runtime.homeMiningStation({ characterID: 1 }), HQ);
  assert.equal(load({ quantumCore: false }).runtime.homeMiningStation({ characterID: 1 }), 60_000_002);
  assert.equal(load({ hqBelts: false }).runtime.homeMiningStation({ characterID: 1 }), 60_000_002);
  assert.equal(load({ hqSecurity: 0.2 }).runtime.homeMiningStation({ characterID: 1 }), 60_000_002);
  assert.equal(load({ noStructure: true }).runtime.homeMiningStation({ characterID: 1 }), 0);
  assert.equal(load().runtime.searchOriginSystemID({ characterID: 1 }), HQ_SYSTEM);
});
