"use strict";

// Territory Map claims: null-sec only, anchored at an Upwell station, then
// stargate-adjacent, at most five, contested when shared, and bot-run
// corporations expand on their own.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// Systems 1-2-3-4-5-6-7 in a line, all null-sec except 7; 8 is high-sec.
// Corp 10 (bot CEO 1001) has an Astrahus in 1, corp 20 (player) one in 3.
const links = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [1, 8]];
const security = { 1: -0.2, 2: -0.1, 3: 0, 4: -0.5, 5: -0.4, 6: -0.3, 7: 0.3, 8: 0.9 };
let stored = null;
let structures = [];
let sovereignty = [];
const hubsAnchored = [];
const stubs = {
  "../../gameStore/tableRepository": { createTableRepository: () => ({
    read: () => ({ success: Boolean(stored), data: stored }),
    write: (_t, _p, value) => { stored = JSON.parse(JSON.stringify(value)); return { success: true }; },
    ensureTable() {}, flushTableSync: () => ({ success: true }),
  }) },
  "./playerBotMapApiRuntime": { buildStaticMap: () => ({ links }) },
  "../../space/worldData": { getSolarSystemByID: (id) => (id in security ? { security: security[id] } : null) },
  "../corporation/corporationState": { getCorporationRecord: (id) =>
    ({ 10: { corporationID: 10, ceoID: 1001 }, 20: { corporationID: 20, ceoID: 2002 } })[id] || null },
  "../structure/structureState": {
    peekStructures: () => structures,
    getStructureTypeByID: (typeID) => ({ 35832: { dockable: true }, 35841: { dockable: false } })[typeID] || null,
  },
  "../corporation/warRuntimeState": { listAllWars: () => [] },
  "../sovereignty/sovState": { listAllSovereigntySystemStates: () => sovereignty, getSystemState: () => null },
  "../sovereignty/sovGmState": { anchorSovereigntyHub: (systemID) => { hubsAnchored.push(systemID); return { success: true }; } },
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function require(id) {
  return Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : originalRequire.apply(this, arguments);
};
const territory = require(path.join(__dirname,
  "../integration/server/server/src/services/playerbots/playerBotTerritoryClaimsRuntime.js"));
// Dependencies load lazily, so the stubs stay in place for this file.

const station = (ownerCorpID, solarSystemID, extra = {}) =>
  ({ structureID: 900 + solarSystemID, typeID: 35832, ownerCorpID, solarSystemID, state: 110, ...extra });

function reset() {
  stored = null;
  sovereignty = [];
  hubsAnchored.length = 0;
  structures = [station(10, 1), station(20, 3)];
  territory._testing.reset();
}

test("claims need null-sec and link back to an anchored Upwell station", () => {
  reset();
  structures.push(station(10, 8)); // high-sec station: not an anchor
  assert.match(territory.claim(10, 8).message, /null-sec/);
  assert.match(territory.claim(10, 3).message, /station system or a stargate jump/);
  assert.equal(territory.claim(10, 1).success, true);
  assert.equal(territory.claim(10, 2).success, true);
  assert.equal(territory.claim(10, 4).success, false, "not linked yet");
  assert.equal(territory.claim(10, 3).success, true);
  assert.equal(territory.claim(99, 1).success, false, "unknown corporation");
});

test("anchoring, unanchoring and non-dockable structures are not anchors", () => {
  reset();
  structures = [station(10, 1, { state: 2 }), station(10, 2, { unanchoring: 1 }), station(10, 4, { typeID: 35841 })];
  assert.deepEqual(territory.anchorSystems(10), []);
  assert.match(territory.claim(10, 1).message, /needs an anchored Upwell station/);
});

test("a corporation holds at most five claims, all null-sec", () => {
  reset();
  for (const id of [1, 2, 3, 4, 5]) assert.equal(territory.claim(10, id).success, true, `claim ${id}`);
  assert.match(territory.claim(10, 6).message, /at most 5/);
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

test("unclaiming drops claims cut off from the anchor claim", () => {
  reset();
  for (const id of [1, 2, 3, 4]) territory.claim(10, id);
  assert.deepEqual(territory.unclaim(10, 2).systems, [1]);
  for (const id of [2, 3]) territory.claim(10, id);
  assert.deepEqual(territory.unclaim(10, 1).systems, [2, 3], "the station system still anchors them");
  structures = structures.filter((entry) => entry.ownerCorpID !== 10);
  assert.deepEqual(territory.unclaim(10, 2).systems, [], "nothing anchors 3 any more");
});

test("bot-run corporations claim around their station, one system per interval", () => {
  reset();
  const bots = [{ characterID: 1001 }];
  let now = 1_000_000;
  const clock = { now: () => now };
  assert.equal(territory.reconcileClaims(bots, clock).claimed, 1);
  assert.deepEqual(territory.getClaims(), { 10: [1] }, "the player corporation does not auto-claim");
  assert.equal(territory.reconcileClaims(bots, clock).claimed, 0, "waits for the interval");
  now += 31 * 60 * 1000;
  assert.equal(territory.reconcileClaims(bots, clock).claimed, 1);
  assert.deepEqual(territory.getClaims()[10], [1, 2], "high-sec neighbour 8 is skipped");
  now += 31 * 60 * 1000;
  territory.reconcileClaims(bots, clock);
  assert.deepEqual(territory.getClaims()[10], [1, 2, 3]);
});

test("losing the anchor station moves or drops the claims", () => {
  reset();
  structures.push(station(10, 2));
  for (const id of [1, 2, 3]) territory.claim(10, id);
  structures = structures.filter((entry) => entry.solarSystemID !== 1);
  territory.reconcileClaims([], {});
  assert.deepEqual(territory.getClaims()[10], [1, 2, 3], "still linked through the station in 2");
  structures = structures.filter((entry) => entry.ownerCorpID !== 10);
  assert.equal(territory.reconcileClaims([], {}).dropped, 3);
  assert.equal(territory.getClaims()[10], undefined);
});

test("claimed systems get a capture target, and a captured claim frees its slot", () => {
  reset();
  for (const id of [1, 2, 3, 4, 5]) territory.claim(10, id);
  assert.deepEqual(hubsAnchored, [1, 2, 3, 4, 5]);
  assert.match(territory.claim(10, 6).message, /capture one/);
  sovereignty = [{ solarSystemID: 1, corporationID: 10, allianceID: 99 }, { solarSystemID: 2, corporationID: 10, allianceID: 99 }];
  const pass = territory.reconcileClaims([], {});
  assert.equal(pass.captured, 2);
  assert.deepEqual(territory.getClaims()[10], [3, 4, 5]);
  assert.equal(territory.claim(10, 6).success, true, "a slot is free again");
  assert.match(territory.claim(10, 1).message, /already holds/);
});

test("a system held by one corporation and claimed by another is contested", () => {
  reset();
  sovereignty = [{ solarSystemID: 4, corporationID: 20, allianceID: 98 }];
  for (const id of [1, 2, 3, 4]) territory.claim(10, id);
  assert.deepEqual(territory.getContested(), { 4: [10, 20] });
});

test("systems near a corporation's territory are counted in stargate jumps", () => {
  reset();
  // Corp 10's only territory is its station system 1.
  assert.deepEqual([...territory.systemsNearTerritory(10, 2)].sort(), [1, 2, 3, 8]);
  assert.deepEqual([...territory.systemsNearTerritory(10, 0)], [1]);
  // A claim widens the reach.
  territory._testing.reset();
  assert.equal(territory.claim(10, 2).success, true);
  assert.equal(territory.systemsNearTerritory(10, 1).has(3), true);
  // No territory at all: null, so callers measure from the bot instead.
  assert.equal(territory.systemsNearTerritory(30, 5), null);
});
