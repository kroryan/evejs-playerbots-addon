"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../integration/server/server/src/services/playerbots/playerBotPlayerCorporationRecruitment"), "utf8");
function fixture(profileCount = 5, memberLimit, botLimit = 1000) {
  const config = { EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION: "ticker:TEST", EVEJS_PLAYER_BOTS_AUTO_RECRUIT_CORPORATION: "1" };
  const target = { corporationID: 41, ceoID: 1, corporationName: "Test Corp", tickerName: "TEST", isNPC: false, memberLimit };
  const profiles = new Map(Array.from({ length: profileCount }, (_, index) => {
    const characterID = index + 2;
    return [characterID, { characterID, corporationID: 42 }];
  }));
  const joined = [];
  const timers = new Set();
  const createsTimer = (run, delay) => {
    const timer = { run, delay, unref() {} };
    timers.add(timer);
    return timer;
  };
  const corporations = {
    findCorporationByTickerName: () => target,
    getCorporationRecord: () => ({ ...target, memberCount: joined.length + 1 }),
    getCharacterIDsInCorporation: () => joined,
    isNpcCorporationID: id => id === 42,
  };
  const playerBots = {
    hasBotProfile: id => profiles.has(id),
    listBotProfiles: () => [...profiles.values()],
    countBotsInCorporation: () => { countCalls++; return joined.length; },
    getBotByCharacterID: id => profiles.get(id),
    acceptBotCorporationInvitation(_service, _session, bot) {
      joined.push(bot.characterID);
      bot.corporationID = 41;
      return { success: true };
    },
    MAX_BOTS_PER_PLAYER_CORPORATION: botLimit,
  };
  const load = { paused: false };
  let countCalls = 0;
  const dependencies = {
    "../corporation/corporationState": corporations,
    "../corporation/corporationMemberLimit": { effectiveCorporationMemberLimit: corp => corp.memberLimit, hasRoomForAnotherMember: (limit, count) => limit == null || limit < 0 || count < limit },
    "../character/characterState": { readSharedCharacterRecord: id => playerBots.getBotByCharacterID(id) },
    "../corporation/corpRegistryRuntime": class { canManageRecruitment(_id, actor) { return actor.characterID === 1; } },
    "./playerBotLoadController": { getPlayerBotLoadController: () => ({ shouldPauseLowPriorityWork: () => load.paused }) },
    "./playerBotRuntime": playerBots,
    "../../utils/logger": { info() {}, warn() {} },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, require: id => dependencies[id], process: { env: config },
    setTimeout: createsTimer, setInterval: createsTimer,
    clearTimeout: timer => timers.delete(timer), clearInterval: timer => timers.delete(timer),
  });
  return {
    recruitment: module.exports, config, officer: { characterID: 1 }, joined, timers, load, counts: () => countCalls,
    batch() {
      const timer = [...timers].find(item => item.delay < 120_000);
      assert.ok(timer);
      timers.delete(timer);
      timer.run();
    },
  };
}

test("recruitment backs off under load and resumes without losing its cursor", () => {
  const f = fixture();
  assert.match(f.recruitment.inviteAll(f.officer), /queued/);
  f.load.paused = true;
  f.batch();
  assert.deepEqual(f.joined, []);
  assert.equal([...f.timers][0].delay, 1000);
  f.load.paused = false;
  f.batch();
  assert.deepEqual(f.joined, [2, 3, 4, 5]);
  f.batch();
  assert.deepEqual(f.joined, [2, 3, 4, 5, 6]);
});

test("only an officer can cancel and a new manual run resumes automatic recruitment", () => {
  const f = fixture();
  f.recruitment.startAutomaticRecruitment();
  const [automatic] = f.timers;
  f.recruitment.inviteAll(f.officer);
  f.batch();
  assert.match(f.recruitment.inviteAll({ characterID: 99 }, null, "cancel"), /Only the target/);
  assert.match(f.recruitment.inviteAll(f.officer, null, "cancel"), /4 joined.*1 not processed.*Automatic recruitment is paused/);
  automatic.run();
  assert.equal(f.timers.size, 1);
  assert.match(f.recruitment.inviteAll(f.officer, null, "status"), /inviteall to resume/);
  assert.match(f.recruitment.inviteAll(f.officer), /Checking 1 managed pilot/);
  f.batch();
  assert.deepEqual(f.joined, [2, 3, 4, 5, 6]);
  assert.doesNotMatch(f.recruitment.inviteAll(f.officer, null, "status"), /to resume/);
});

test("mass recruitment stops exactly at the 1,000-bot limit across batches", () => {
  const f = fixture(1005);
  f.recruitment.inviteAll(f.officer);
  for (let batch = 0; batch < 251; batch++) f.batch();
  assert.equal(f.joined.length, 1000);
  assert.equal(f.timers.size, 0);
  assert.match(f.recruitment.inviteAll(f.officer, null, "status"), /1000 joined.*5 not processed.*limit reached/);
});

test("15,000 total seats include the CEO and avoid repeated bot counting when the total cap suffices", () => {
  const f = fixture(15_010, 15_000, 15_000);
  f.recruitment.inviteAll(f.officer);
  while (f.timers.size) f.batch();
  assert.equal(f.joined.length, 14_999);
  assert.equal(f.counts(), 0);
  assert.match(f.recruitment.inviteAll(f.officer, null, "status"), /14999 joined.*11 not processed.*member limit reached/);
});


test("inviteall without a configured target fills the caller's own player corporation", () => {
  const f = fixture(2);
  delete f.config.EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION;
  assert.match(f.recruitment.inviteAll({ characterID: 1, corporationID: 41 }), /queued for Test Corp/);
  f.batch();
  assert.deepEqual(f.joined, [2, 3]);
  assert.match(f.recruitment.inviteAll({ characterID: 7, corporationID: 42 }), /EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION in \.env/);
});
