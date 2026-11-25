"use strict";

// Bot alliances: who allies with whom, and founding and recruiting through
// the game's alliance authority.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const SOURCE = path.resolve(__dirname, "../integration/server/server/src/services/playerbots/playerBotAllianceFormationRuntime.js");
const A = 98000001, B = 98000002, C = 98000003, ENEMY = 98000009;

function world(overrides = {}) {
  const runtime = require(SOURCE);
  const { deps } = runtime._testing;
  runtime._testing.reset();
  const calls = [];
  let saved = {};
  const corps = new Map([
    [A, { corporationName: "Alpha", ceoID: 1, allianceID: 0 }],
    [B, { corporationName: "Bravo", ceoID: 2, allianceID: 0 }],
    [C, { corporationName: "Charlie", ceoID: 3, allianceID: 0 }],
  ]);
  const bots = [
    { characterID: 1, characterName: "Ann", corporationID: A }, { characterID: 11, characterName: "Al", corporationID: A },
    { characterID: 2, characterName: "Bea", corporationID: B }, { characterID: 3, characterName: "Cy", corporationID: C },
  ];
  const applications = new Map();
  Object.assign(deps, {
    store: () => ({ read: () => saved, write: (value) => { saved = JSON.parse(JSON.stringify(value)); } }),
    corporations: () => ({
      getCorporationRecord: (id) => corps.get(Number(id)) || null,
      findAllianceByExactName: (name) => (overrides.taken || []).includes(name),
      findCorporationByName: () => false, findAllianceByShortName: () => false, findCorporationByTickerName: () => false,
    }),
    characters: () => ({ getCharacterRecord: (id) => ({ raceID: Number(id) === 3 ? 4 : 1 }) }),
    playerBots: () => ({ listBots: () => bots }),
    settings: () => ({ allianceMode: overrides.mode ?? 1 }),
    grievances: () => ({
      getOverview: () => ({ grievances: (overrides.feuds || []).map(([victim, aggressor]) => ({ victim: { corporationID: victim }, aggressor: { corporationID: aggressor }, hostile: true })) }),
      isHostileCorporation: (left, right) => (overrides.grudges || []).some(([x, y]) => x === left && y === right),
    }),
    wars: () => ({ listAllWars: () => [] }),
    logger: () => ({ info() {}, warn() {} }),
    skills: () => ({ getCharacterSkillMap: () => new Map(), grantCharacterSkillLevels: (id, grants) => calls.push(["skill", id, grants[0].typeID]) }),
    wallet: () => ({ getCharacterWallet: () => ({ balance: 5_000_000 }), adjustCharacterBalanceAsync: async (id, amount) => { calls.push(["grant", id, amount]); return { success: true }; } }),
    space: () => ({ getActorSession: (bot) => ({ characterID: bot.characterID }) }),
    founding: () => ({ getPendingAllianceFounding: () => null }),
    corpRegistry: () => ({
      Handle_CreateAlliance: async ([name, ticker], session) => {
        calls.push(["create", session.characterID, name, ticker]);
        const corp = [...corps.entries()].find(([, record]) => record.ceoID === session.characterID)[1];
        corp.allianceID = 99000001;
      },
      Handle_ApplyToJoinAlliance: ([allianceID], session) => {
        calls.push(["apply", session.characterID, allianceID]);
        applications.set(session.characterID, { state: 1 });
      },
    }),
    allianceRegistry: () => ({ Handle_UpdateApplication: ([corporationID, , state], session) => calls.push(["accept", session.characterID, corporationID, state]) }),
    applications: () => ({ getAllianceApplication: (allianceID, corporationID) => applications.get(corps.get(corporationID).ceoID) || null }),
    images: () => ({ storeAllianceLogo: (id, bytes) => { calls.push(["logo", id, bytes.length]); return { success: true }; } }),
    formation: () => ({
      normalizeAllianceFormationOptions: (options) => options,
      validateAllianceFormationOptions: (options) => (options.name.length < 3 ? { success: false, errorMsg: "ALLIANCE_NAME_INVALID_LENGTH" } : { success: true }),
    }),
  });
  return { runtime, calls, corps, bots };
}

test("corporations with a shared enemy and no grudge between them ally", () => {
  const { runtime } = world({ feuds: [[A, ENEMY], [B, ENEMY], [C, 98000008]] });
  const corps = new Map([[A, {}], [B, {}], [C, {}]]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime._testing.karmaCoalitions(corps))), [[A, B]]);
  const grudge = world({ feuds: [[A, ENEMY], [B, ENEMY]], grudges: [[A, B]] });
  assert.equal(grudge.runtime._testing.karmaCoalitions(corps).length, 0, "a grudge keeps them apart");
});

test("at population each empire's corporations band together", () => {
  const { runtime } = world();
  const corps = new Map([[A, { corporationID: A, raceID: 1 }], [B, { corporationID: B, raceID: 1 }], [C, { corporationID: C, raceID: 4 }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime._testing.populationGroups(corps))), [[A, B]]);
});

test("a karma alliance takes a science-fiction name, is founded by the biggest corp, and recruits its ally", async () => {
  const { runtime, calls, bots } = world({ feuds: [[A, ENEMY], [B, ENEMY]], taken: ["Rebel Alliance"] });
  await runtime.maintain(bots, { force: true }); // plan and found
  await runtime.maintain(bots, { force: true }); // the ally applies and is accepted
  const overview = JSON.parse(JSON.stringify(runtime.getOverview()));
  const [design] = overview.designs;
  assert.equal(design.name, "Interstellar Alliance", "the first free famous name");
  assert.equal(design.founder.corporationID, A, "Alpha has more pilots");
  assert.deepEqual(calls.filter((call) => call[0] !== "logo").map((call) => call[0]), ["skill", "grant", "create", "apply", "accept"]);
  assert.deepEqual(calls.find((call) => call[0] === "accept"), ["accept", 1, B, 2]);
});

test("the dashboard designs alliances with a logo, and checks names and founders", async () => {
  const { runtime, calls, bots } = world({ mode: 0 });
  assert.equal(runtime.runCommand({ action: "create", name: "X", ticker: "X", founderCorporationID: A }).success, false);
  assert.equal(runtime.runCommand({ action: "create", name: "Grand Alliance", ticker: "GRAND", founderCorporationID: A, logo: "data:text/html;base64,AAAA" }).success, false);
  const made = runtime.runCommand({ action: "create", name: "Grand Alliance", ticker: "GRAND", founderCorporationID: C, memberCorporationIDs: [A, C], logo: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(made.success, true);
  await runtime.maintain(bots, { force: true });
  await runtime.maintain(bots, { force: true });
  assert.deepEqual(calls.find((call) => call[0] === "create"), ["create", 3, "Grand Alliance", "GRAND"]);
  assert.ok(calls.find((call) => call[0] === "logo"), "the logo goes to the alliance image store");
  assert.ok(calls.find((call) => call[0] === "apply" && call[1] === 1), "Alpha applies; Charlie founded it");
  assert.equal(runtime.runCommand({ action: "delete", id: made.id }).success, false, "an alliance in game cannot be removed here");
});
