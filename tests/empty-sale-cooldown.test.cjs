"use strict";

// A sell operation that sold and listed nothing must not be repeated at once.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The director needs a full EveJS tree; evaluate just the cooldown and its constant.
const source = fs.readFileSync(path.join(__dirname, "../integration/server/server/src/services/playerbots/playerBotDirectorRuntime.js"), "utf8");
const constant = source.match(/const EMPTY_SALE_RETRY_COOLDOWN_MS = [^;]+;/)[0];
const fn = source.match(/function emptySaleCoolingDown[\s\S]*?\n}\r?\n/)[0];
const _testing = vm.runInNewContext(`${constant}\n${fn}\n({ emptySaleCoolingDown })`, { Date, Number });

test("an empty sale cools down sell retries for two hours", () => {
  const now = Date.parse("2026-11-26T05:00:00Z");
  const sale = (over) => ({ kind: "sell", status: "completed", unitsSold: 0, unitsListed: 0, completedAt: new Date(now - 60_000).toISOString(), ...over });
  assert.equal(_testing.emptySaleCoolingDown(sale(), now), true);
  assert.equal(_testing.emptySaleCoolingDown(sale({ completedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() }), now), false);
  assert.equal(_testing.emptySaleCoolingDown(sale({ unitsSold: 3 }), now), false);
  assert.equal(_testing.emptySaleCoolingDown(sale({ unitsListed: 1 }), now), false);
  assert.equal(_testing.emptySaleCoolingDown(sale({ kind: "mine" }), now), false);
  assert.equal(_testing.emptySaleCoolingDown(null, now), false);
});
