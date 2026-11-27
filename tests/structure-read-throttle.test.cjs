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
