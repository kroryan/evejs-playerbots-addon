"use strict";

// Territory Map intel: trade routes from bot operations, and the dispatch
// order that sends a corporation's bots to mine or defend a system.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const started = [];
const stopped = [];
const operations = { 2: { kind: "sell", status: "active" } };
const stubs = {
  "../../space/worldData": {
    getStationByID: (id) => ({ 60001: { solarSystemID: 1 }, 60002: { solarSystemID: 2 } })[id] || null,
    getStationsForSystem: (id) => (id === 1 ? [{ stationID: 60001 }] : []),
    getAsteroidBeltsForSystem: (id) => (id === 1 ? [{}] : []),
  },
  "../structure/structureState": { peekStructures: () => [], getStructureTypeByID: () => null },
  "./playerBotSpaceRuntime": { findStargateRoute: (a, b) => (a === 1 && b === 4
    ? { success: true, systemIDs: [1, 2, 3, 4] } : { success: false }) },
  "./playerBotRuntime": { listBots: () => [
    { characterID: 1, characterName: "Idle Miner", specialty: "mining" },
    { characterID: 2, characterName: "Busy Trader", specialty: "trade" },
    { characterID: 3, characterName: "Other Corp", specialty: "mining" },
  ] },
  "../character/characterState": { readSharedCharacterRecord: (id) => ({ corporationID: id === 3 ? 20 : 10 }) },
  "./playerBotCapacityRuntime": { getHumanControlledBotIDs: () => new Set() },
  "./playerBotOperationRuntime": {
    getOperation: (id) => operations[id] || null,
    hasActiveOperation: (id) => Boolean(operations[id]),
    stopOperation: (name) => { stopped.push(name); return { success: true }; },
    startMining: (name, trips, options) => { started.push([name, options.stationID]); return { success: true }; },
    startCombat: (name, mode, options) => { started.push([name, options.patrolSystemID]); return { success: true }; },
  },
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function require(id) {
  return Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : originalRequire.apply(this, arguments);
};
const intel = require(path.join(__dirname,
  "../integration/server/server/src/services/playerbots/playerBotMapIntelRuntime.js"));

test("trade routes run between the systems of an operation's stations", () => {
  const ends = intel._testing.routeEnds({ kind: "sell", originStationID: 60001, marketStationID: 60002 }, new Map());
  assert.deepEqual(ends, [1, 2]);
  assert.equal(intel._testing.routeEnds({ kind: "mine" }, new Map()), null);
  assert.equal(intel._testing.routeEnds({ kind: "haul", fromStationID: 60001, toStationID: 60001 }, new Map()), null);
});

test("routes carry the stargate path bots fly, not a straight line", () => {
  assert.deepEqual(intel._testing.routePath(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(intel._testing.routePath(1, 9), [1, 9], "no route found: just the two ends");
});

test("dispatch checks the order and the system", () => {
  assert.equal(intel.commandBots(10, 1, "dance", 2).success, false);
  assert.match(intel.commandBots(10, 2, "mine", 2).message, /no asteroid belts/);
});

test("dispatch starts idle corporation bots and switches busy ones over", () => {
  intel._testing.reset();
  const result = intel.commandBots(10, 1, "mine", 2);
  assert.equal(result.started, 1);
  assert.equal(result.switching, 1);
  assert.deepEqual(started, [["Idle Miner", 60001]]);
  assert.deepEqual(stopped, ["Busy Trader"], "only bots in the corporation");
  intel._testing.reset();
});
