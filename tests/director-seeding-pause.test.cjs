"use strict";

// While gradual seeding fills the roster, the director assigns no new work
// unless the operator turns "Work while seeding" on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const services = path.join(__dirname, "../integration/server/server/src/services/playerbots");

// The director needs a full EveJS tree; evaluate just the check.
const director = fs.readFileSync(path.join(services, "playerBotDirectorRuntime.js"), "utf8");
const fn = director.match(/function isPausedForSeeding[\s\S]*?\n}\r?\n/)[0];

function pausedFor(settings, botCount) {
  const modules = {
    "./playerBotConfigurationRuntime": { getSettings: () => settings },
    "./playerBotRuntime": { getBotCount: () => botCount },
  };
  const check = vm.runInNewContext(`${fn}\nisPausedForSeeding`, { Number, require: (name) => modules[name] });
  return check();
}

test("the director pauses while seeding is below the roster target", () => {
  const seeding = { rosterSeedEnabled: true, directorWhileSeeding: false, rosterTarget: 5000 };
  assert.equal(pausedFor(seeding, 1200), true);
  assert.equal(pausedFor(seeding, 5000), false, "target reached");
  assert.equal(pausedFor({ ...seeding, rosterSeedEnabled: false }, 1200), false, "seeding off");
  assert.equal(pausedFor({ ...seeding, directorWhileSeeding: true }, 1200), false, "operator allows work");
});

test("work while seeding is off by default", () => {
  const configuration = fs.readFileSync(path.join(services, "playerBotConfigurationRuntime.js"), "utf8");
  assert.match(configuration, /directorWhileSeeding: process\.env\.EVEJS_PLAYER_BOTS_DIRECTOR_WHILE_SEEDING === "1"/);
  assert.match(configuration, /"directorWhileSeeding"/, "the setting can be saved");
});
