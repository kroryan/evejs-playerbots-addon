"use strict";

// Structure reads still refresh, but the full structure tick runs at most once
// per interval.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const throttle = require(path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotStructureReadThrottle.js"));

test("structure reads tick at most once per interval", () => {
  const refreshes = [];
  const structureState = { getStructureByID: (id, options) => { refreshes.push(options.refresh); return { id }; } };
  let now = 10_000;
  throttle._testing.reset();
  assert.equal(throttle.install({ structureState, now: () => now }), true);
  for (let i = 0; i < 50; i += 1) structureState.getStructureByID(1);
  assert.deepEqual(refreshes.filter(Boolean).length, 1);
  structureState.getStructureByID(1, { refresh: false });
  assert.equal(refreshes[refreshes.length - 1], false);
  now += throttle.MIN_TICK_INTERVAL_MS;
  structureState.getStructureByID(1);
  assert.equal(refreshes[refreshes.length - 1], true);
  throttle._testing.reset();
});

test("the tick's structure sync runs at most every interval per system; other syncs run at once", () => {
  let now = 50_000;
  const calls = [];
  const proto = { syncStructureEntitiesFromState(options) { calls.push(options); return { added: [], updated: [] }; } };
  throttle._testing.reset();
  throttle.install({ structureState: { getStructureByID: () => null }, now: () => now, sceneProto: proto });
  const a = Object.create(proto);
  const b = Object.create(proto);
  a.syncStructureEntitiesFromState({ refresh: false });
  a.syncStructureEntitiesFromState({ refresh: false });
  b.syncStructureEntitiesFromState({ refresh: false });
  assert.equal(calls.length, 2);
  a.syncStructureEntitiesFromState({ broadcast: false });
  a.syncStructureEntitiesFromState();
  assert.equal(calls.length, 4);
  now += throttle.STRUCTURE_SYNC_INTERVAL_MS;
  a.syncStructureEntitiesFromState({ refresh: false });
  assert.equal(calls.length, 5);
  throttle._testing.reset();
});

test("docked pilot counts come from one character scan per second", () => {
  let now = 1_000;
  let scans = 0;
  const records = { 1: { structureID: 9 }, 2: { structureID: 9 }, 3: { structureID: 8 }, 4: { stationID: 60000001 } };
  const structureState = { getStructureByID: () => null, countCharactersDockedInStructure: () => -1 };
  throttle._testing.reset();
  throttle.install({ structureState, now: () => now, sceneProto: { syncStructureEntitiesFromState() {} }, readCharacters: () => { scans += 1; return records; } });
  assert.equal(structureState.countCharactersDockedInStructure(9), 2);
  assert.equal(structureState.countCharactersDockedInStructure(8), 1);
  assert.equal(structureState.countCharactersDockedInStructure(7), 0);
  assert.equal(scans, 1);
  records[5] = { structureID: 7 };
  now += throttle.DOCKED_COUNT_TTL_MS;
  assert.equal(structureState.countCharactersDockedInStructure(7), 1);
  assert.equal(scans, 2);
  throttle._testing.reset();
});
