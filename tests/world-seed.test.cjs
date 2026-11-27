"use strict";

// World seed: structures are brought online the way EveJS's own automation
// does it, and a run needs the typed confirmation.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const S = { UNANCHORED: 1, ANCHORING: 2, ONLINING_VULNERABLE: 102, SHIELD_VULNERABLE: 110, ANCHOR_VULNERABLE: 115 };
let structure = null;
const calls = [];
const stubs = {
  "../structure/structureConstants": { STRUCTURE_STATE: S, STRUCTURE_SERVICE_ID: { DOCKING: 1 }, STRUCTURE_SERVICE_STATE: { ONLINE: 1, OFFLINE: 0 } },
  "../structure/structureState": {
    getStructureByID: () => structure,
    startAnchoring: () => { calls.push("anchor"); structure = { ...structure, state: S.ANCHOR_VULNERABLE }; return { success: true }; },
    fastForwardStructure: () => {
      calls.push("ff");
      structure = { ...structure, state: structure.state === S.ANCHOR_VULNERABLE ? S.ANCHORING : S.SHIELD_VULNERABLE };
      return { success: true };
    },
    setStructureQuantumCoreInstalled: () => {
      calls.push("core");
      structure = { ...structure, hasQuantumCore: true, state: S.ONLINING_VULNERABLE };
      return { success: true };
    },
    setStructureServiceState: () => { calls.push("dock"); structure = { ...structure, serviceStates: { 1: 1 } }; return { success: true }; },
  },
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function require(id) {
  return Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : originalRequire.apply(this, arguments);
};
const seed = require(path.join(__dirname,
  "../integration/server/server/src/services/playerbots/playerBotWorldSeedRuntime.js"));

test("a seeded structure goes from unanchored to online with docking", async () => {
  structure = { structureID: 1, state: S.UNANCHORED, hasQuantumCore: false, serviceStates: {} };
  seed._testing.setDeps({ schedule: (callback) => setImmediate(callback) });
  const online = await seed._testing.bringOnline(1);
  assert.equal(online.state, S.SHIELD_VULNERABLE);
  assert.deepEqual(calls, ["anchor", "ff", "core", "dock", "ff"]);
});

test("a run needs the typed confirmation", () => {
  seed._testing.setDeps({ repo: () => ({ read: () => ({ success: false }), write() {}, ensureTable() {}, flushTableSync() {} }) });
  const result = seed.startSeed({ confirmation: "yes" });
  assert.equal(result.success, false);
  assert.match(result.message, /SEED NEW EDEN/);
  assert.equal(seed.isRunning(), false);
});
