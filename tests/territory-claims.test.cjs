"use strict";

// Territory Map claims: first claim at headquarters, then stargate-adjacent,
// at most five, contested when shared, and unclaiming drops disconnected claims.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// Systems 1-2-3-4-5-6-7 in a line; corp 10 has a structure in 1, corp 20 in 3.
const links = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]];
let stored = null;
const stubs = {
  "../../gameStore/tableRepository": { createTableRepository: () => ({
    read: () => ({ success: Boolean(stored), data: stored }),
    write: (_t, _p, value) => { stored = JSON.parse(JSON.stringify(value)); return { success: true }; },
    ensureTable() {}, flushTableSync: () => ({ success: true }),
  }) },
  "./playerBotMapApiRuntime": { buildStaticMap: () => ({ links }) },
  "../../space/worldData": { getSolarSystemByID: (id) => (id >= 1 && id <= 7 ? { id } : null), getStationByID: () => null },
  "../corporation/corporationState": { getCorporationRecord: (id) => ([10, 20].includes(id) ? { corporationID: id } : null) },
  "../structure/structureState": { listStructures: () => [
    { structureID: 900, ownerCorpID: 10, solarSystemID: 1 }, { structureID: 901, ownerCorpID: 20, solarSystemID: 3 },
  ] },
  "../corporation/warRuntimeState": { listAllWars: () => [] },
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function require(id) {
  return Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : originalRequire.apply(this, arguments);
};
const territory = require(path.join(__dirname,
  "../integration/server/server/src/services/playerbots/playerBotTerritoryClaimsRuntime.js"));
// Dependencies load lazily, so the stubs stay in place for this file.

function reset() { stored = null; territory._testing.reset(); }

test("first claim must be at headquarters, later ones adjacent", () => {
  reset();
  assert.equal(territory.claim(10, 2).success, false);
  assert.equal(territory.claim(10, 1).success, true);
  assert.equal(territory.claim(10, 3).success, false, "not adjacent to 1");
  assert.equal(territory.claim(10, 2).success, true);
  assert.equal(territory.claim(10, 2).success, false, "duplicate");
  assert.equal(territory.claim(99, 1).success, false, "unknown corporation");
});

test("a corporation holds at most five claims", () => {
  reset();
  for (const id of [1, 2, 3, 4, 5]) assert.equal(territory.claim(10, id).success, true, `claim ${id}`);
  const sixth = territory.claim(10, 6);
  assert.equal(sixth.success, false);
  assert.match(sixth.message, /at most 5/);
});

test("shared systems are contested and persist", () => {
  reset();
  territory.claim(10, 1); territory.claim(10, 2);
  territory.claim(20, 3); territory.claim(20, 2);
  assert.deepEqual(territory.getContested(), { 2: [10, 20] });
  assert.deepEqual(territory.getContestedSystemsForCorporation(20), [2]);
  territory._testing.reset(); // reload from storage
  assert.deepEqual(territory.getClaims(), { 10: [1, 2], 20: [3, 2] });
  assert.equal(territory.getTerritoryWars()["10:20"].warID, 0);
});

test("unclaiming drops claims cut off from headquarters", () => {
  reset();
  for (const id of [1, 2, 3, 4]) territory.claim(10, id);
  assert.deepEqual(territory.unclaim(10, 2).systems, [1]);
  for (const id of [2, 3]) territory.claim(10, id);
  const result = territory.unclaim(10, 1);
  assert.deepEqual(result.systems, []);
  assert.deepEqual(territory.getClaims(), {});
});
