"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../integration/server/server/src/services/playerbots/playerBotRuntime"), "utf8");
const body = /function releaseBotCorporationRoles[\s\S]*?\n}\n/.exec(source)[0];

function fixture(ceoIsBot) {
  const members = { 5: { characterID: 5, roles: "1", rolesAtHQ: "8", titleMask: 2 }, 9: { characterID: 9, roles: "1" } };
  const synced = [];
  const runtimeState = {
    getCorporationMember: (_corp, id) => ({ ...members[id] }),
    updateCorporationRuntime: (_corp, mutate) => mutate({ members }),
    syncMemberStateToCharacterRecord: (_corp, id) => synced.push(id),
  };
  const context = {
    require: () => runtimeState,
    getCorporationRecord: () => ({ corporationID: 77, ceoID: 9 }),
    repo: { read: (_table, path) => ({ success: ceoIsBot || path !== "/9" }) },
    TABLE: "playerBots",
  };
  vm.runInNewContext(`${body}; this.release = releaseBotCorporationRoles;`, context);
  return { release: context.release, members, synced };
}

test("a bot leaving a bot-run corporation drops its roles and titles", () => {
  const f = fixture(true);
  assert.equal(f.release(77, 5), true);
  assert.equal(f.members[5].roles, "0");
  assert.equal(f.members[5].rolesAtHQ, "0");
  assert.equal(f.members[5].titleMask, 0);
  assert.deepEqual(f.synced, [5]);
});

test("the CEO and members of player-run corporations keep their roles", () => {
  const bot = fixture(true);
  assert.equal(bot.release(77, 9), false);
  const player = fixture(false);
  assert.equal(player.release(77, 5), false);
  assert.equal(player.members[5].roles, "1");
});
