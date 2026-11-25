"use strict";

// The director ranks every idle pilot by headquarters priority and asks
// structure managers for a purchase plan on every pass. These checks must
// stay cheap: no deep copy of the universe's structures, no actor session for
// pilots whose corporation already has a structure, and no repeated market
// search after a failed purchase plan.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const file = path.resolve(__dirname,
  "../integration/server/server/src/services/playerbots/playerBotStructureRuntime.js");

function load({ structures = [], ceoID = 0, managers = [] } = {}) {
  const calls = { listStructures: 0, peekStructures: 0, actorSession: 0, typeLookups: 0, operationScans: 0 };
  const bots = [1001, 1002, 1003].map((characterID) => ({ characterID, corporationID: 42, status: "active" }));
  const services = {
    // The real hull list: plain data, no further requires.
    "./playerBotTransportHulls": require(path.join(path.dirname(file), "playerBotTransportHulls")),
    "../../space/worldData": {},
    "../character/characterState": { getCharacterRecord: (id) => ({ characterID: id, corporationID: 42 }) },
    "../structure/structureState": {
      listStructures() { calls.listStructures += 1; return structures.map((row) => ({ ...row })); },
      peekStructures() { calls.peekStructures += 1; return structures; },
      getStructureTypeByID(typeID) { calls.typeLookups += 1; return Number(typeID) === 35832 ? { dockable: true, name: "Astrahus" } : null; },
    },
    "./playerBotRuntime": { listBots: () => bots },
    "../corporation/corporationState": { getCorporationRecord: () => ({ corporationID: 42, ceoID }) },
    "../corporation/corporationRuntimeState": {
      CORP_ROLE_DIRECTOR: 1n,
      getCorporationMemberRoleMask: () => 0,
    },
    "./playerBotOperationRuntime": {},
    "./playerBotOperationRecords": {
      // Another pilot already holds the corporation's procurement order, so
      // the plan fails after the operation scan.
      listReadOnlyOperations() {
        calls.operationScans += 1;
        return [{ corporationID: 42, kind: "structure-procurement", status: "active" }];
      },
    },
    "./playerBotSpaceRuntime": { getActorSession(bot) { calls.actorSession += 1; return { characterID: bot.characterID }; } },
    "../corporation/corporationAuthority": {
      getPersistedCorporationAuthority: (session) => ({ isCEO: managers.includes(session.characterID), isDirector: false }),
      corporationAuthorityHasRole: () => false,
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports, console, Date, Map, Set, BigInt, Math, Number, String, Object, Array, JSON,
    require(id) {
      assert.ok(Object.hasOwn(services, id), `Unexpected dependency: ${id}`);
      return services[id];
    },
  }, { filename: file });
  return { api: module.exports, calls };
}

const astrahus = { structureID: 9001, typeID: 35832, ownerCorpID: 42 };

test("a corporation with a structure ranks only its caretaker first, without actor sessions", () => {
  const { api, calls } = load({ structures: [astrahus], ceoID: 1002 });
  assert.equal(api.getHeadquartersPriority({ characterID: 1002, corporationID: 42 }), 0);
  assert.equal(api.getHeadquartersPriority({ characterID: 1001, corporationID: 42 }), 1);
  assert.equal(api.getHeadquartersPriority({ characterID: 1003, corporationID: 42 }), 1);
  assert.equal(calls.actorSession, 0);
  assert.equal(calls.listStructures, 0);
});

test("purchase planning stops at the cached check when the corporation already has a structure", () => {
  const { api, calls } = load({ structures: [astrahus], managers: [1001] });
  for (let pass = 0; pass < 5; pass += 1) {
    assert.equal(api.findAutonomousPurchasePlan({ characterID: 1001, corporationID: 42, specialty: "trade" }), null);
  }
  assert.equal(calls.actorSession, 0);
  assert.equal(calls.listStructures, 0);
  assert.equal(calls.peekStructures, 1, "one cached structure scan for the corporation");
});

test("structure-manager authority is checked once per pilot while the corporation has no structure", () => {
  const { api, calls } = load({ managers: [1001] });
  for (let pass = 0; pass < 5; pass += 1) {
    assert.equal(api.getHeadquartersPriority({ characterID: 1001, corporationID: 42 }), 0);
    assert.equal(api.getHeadquartersPriority({ characterID: 1003, corporationID: 42 }), 1);
  }
  assert.equal(calls.actorSession, 2);
  assert.equal(calls.listStructures, 0);
});

test("a failed purchase plan is not rebuilt on every director pass", () => {
  const { api, calls } = load({ managers: [1001] });
  const bot = { characterID: 1001, corporationID: 42, specialty: "trade" };
  assert.equal(api.findAutonomousPurchasePlan(bot), null);
  assert.equal(calls.operationScans, 1);
  for (let pass = 0; pass < 5; pass += 1) assert.equal(api.findAutonomousPurchasePlan(bot), null);
  assert.equal(calls.operationScans, 1, "retried at most once a minute");
});
