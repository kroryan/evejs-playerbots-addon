"use strict";

// Site upkeep purges a few sites at a time and stops after its time budget,
// then comes back sooner while sites are still waiting.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const upkeep = require(path.join(__dirname,
  "../integration/server/server/src/services/playerbots/playerBotSiteUpkeepRuntime.js"));

function deps(siteCount, calls) {
  const entries = Array.from({ length: siteCount }, (_, index) => ({
    siteOrigin: "universe_dungeon", solarSystemID: 30000001 + index, instanceID: 1000 + index,
  }));
  return {
    repo: () => ({ ensureTable() {}, read: () => ({ success: true, data: {} }), write() {} }),
    space: () => ({ isSolarSystemSceneLoaded: () => false }),
    dungeonState: () => ({ listUniversePersistentLifecycleEntries: () => entries }),
    dungeon: () => ({ purgeInstances: (ids) => { calls.push(ids.length); return { removedCount: ids.length }; } }),
    sessions: () => [],
    isBotSession: () => false,
  };
}

test("a pass stops purging once its time budget is spent", () => {
  upkeep._testing.reset();
  const calls = [];
  let now = 0;
  // Each purge call costs 100 ms on this clock.
  const clock = () => { now += 50; return now; };
  const result = upkeep.runSiteUpkeepPass({ force: true, nowMs: 1_000_000, deps: deps(200, calls), clock, env: {} });
  assert.ok(result.purged > 0 && result.purged < 200, `purged ${result.purged}`);
  assert.ok(calls.every((size) => size <= 5), "purges in small chunks");
  assert.equal(result.remaining, 200 - result.purged);
});

test("a backlog brings the next pass forward", () => {
  upkeep._testing.reset();
  const calls = [];
  let now = 0;
  const clock = () => { now += 200; return now; };
  upkeep.runSiteUpkeepPass({ nowMs: 1_000_000, deps: deps(50, calls), clock, env: {} });
  assert.equal(upkeep.runSiteUpkeepPass({ nowMs: 1_005_000, deps: deps(50, calls), clock, env: {} }).skipped, "interval");
  assert.notEqual(upkeep.runSiteUpkeepPass({ nowMs: 1_011_000, deps: deps(50, calls), clock, env: {} }).skipped, "interval");
});

test("without a backlog the pass waits a minute", () => {
  upkeep._testing.reset();
  const calls = [];
  const clock = () => 0;
  upkeep.runSiteUpkeepPass({ nowMs: 1_000_000, deps: deps(3, calls), clock, env: {} });
  assert.equal(upkeep.runSiteUpkeepPass({ nowMs: 1_011_000, deps: deps(3, calls), clock, env: {} }).skipped, "interval");
});
