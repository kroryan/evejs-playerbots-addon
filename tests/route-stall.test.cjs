"use strict";

// A route that has not moved for an hour stops its operation (as the
// dashboard's Stop does) and logs why, instead of re-queuing forever.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../integration/server/server/src/services/playerbots/playerBotAutonomyRuntime"), "utf8");
const body = source.slice(source.indexOf("const ROUTE_STALL_MS"), source.indexOf("async function handleNavigationJob"));

function fixture({ pending = null, currentTask = null } = {}) {
  const calls = { stopped: [], cancelled: [], warnings: [] };
  const task = { taskID: "PB1", kind: "playerbot.space.route", status: "queued", resourceOwnerCharacterID: 7, progress: { stage: "undocking" } };
  const modules = {
    "./playerBotInterruptRuntime": { hasPending: () => Boolean(pending), pending: () => ({ pending }), isBusy: () => false },
    "./playerBotLocalDefenseAdapter": { hasLease: () => false },
    "./playerBotOperationRuntime": {
      getOperation: () => ({ routeTaskID: "PB1" }),
      stopOperation: (name) => { calls.stopped.push(name); return { success: true, message: "stopped" }; },
    },
    "./playerBotTaskRuntime": { getTask: () => task, cancelTask: (id) => calls.cancelled.push(id) },
    "../../utils/logger": { warn: (message) => calls.warnings.push(message) },
  };
  const context = {
    require: (id) => modules[id],
    getPlayerBotRuntime: () => ({ getBotByCharacterID: () => ({ characterName: "Pilot", currentTask }) }),
    Date,
    Number,
    String,
    Math,
  };
  vm.runInNewContext(`${body}; this.release = releaseStalledRoute; this.STALL = ROUTE_STALL_MS;`, context);
  return { ...context, task, calls };
}

test("a route that moved recently is left alone", () => {
  const f = fixture();
  f.task.updatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert.equal(f.release(f.task), null);
  assert.deepEqual(f.calls.stopped, []);
});

test("an hour without progress stops the operation, cancels the route and names the blocker", () => {
  const f = fixture({ pending: { kind: "retreat" } });
  f.task.updatedAt = new Date(Date.now() - f.STALL - 60_000).toISOString();
  const result = f.release(f.task);
  assert.equal(result.stalled, true);
  assert.deepEqual(f.calls.stopped, ["Pilot"]);
  assert.deepEqual(f.calls.cancelled, ["PB1"]);
  assert.match(f.calls.warnings[0], /made no progress for 61 min \(stage undocking; blockers: pending interruption retreat\)/);
});
