"use strict";

// Grievances and gate camps: attacks become hostility, then war; gate
// campers only shoot lawful targets.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const DIR = path.resolve(__dirname, "../integration/server/server/src/services/playerbots");
const OURS = 98000010;
const THEM = 98000020;
const ALLY = 98000030;

function grievances() {
  const runtime = require(path.join(DIR, "playerBotGrievanceRuntime.js"));
  const { deps } = runtime._testing;
  let saved = {};
  const characters = new Map([
    [1, { corporationID: OURS }], [2, { corporationID: OURS }],
    [10, { corporationID: THEM }], [11, { corporationID: 1000125 }], // an NPC corporation
    [12, { corporationID: ALLY, allianceID: 99000001 }], [3, { corporationID: OURS, allianceID: 99000001 }],
  ]);
  deps.store = () => ({ read: () => saved, write: (value) => { saved = JSON.parse(JSON.stringify(value)); } });
  deps.characters = () => ({ getCharacterRecord: (id) => characters.get(Number(id)) || null });
  deps.corporations = () => ({ getCorporationRecord: (id) => ({ corporationName: `Corp ${id}`, allianceID: id === OURS ? 0 : 0 }) });
  deps.wars = () => ({ listAllWars: () => [] });
  deps.playerBots = () => ({ hasBotProfile: (id) => Number(id) < 10, listBots: () => [] });
  deps.logger = () => ({ info() {}, warn() {} });
  runtime._testing.reset();
  return { runtime, saved: () => saved };
}

test("repeat attacks mark the aggressor hostile, and count once per two minutes per pair", () => {
  const { runtime } = grievances();
  const t0 = Date.parse("2026-11-25T10:00:00Z");
  assert.ok(runtime.recordAggression({ victimCharacterID: 1, attackerCharacterID: 10, whenMs: t0 }));
  assert.equal(runtime.recordAggression({ victimCharacterID: 1, attackerCharacterID: 10, whenMs: t0 + 30_000 }), null, "same fight");
  assert.equal(runtime.isHostileCorporation(OURS, THEM, t0 + 60_000), false, "one attack is not enough");
  runtime.recordAggression({ victimCharacterID: 2, attackerCharacterID: 10, whenMs: t0 + 60_000 });
  assert.equal(runtime.isHostileCorporation(OURS, THEM, t0 + 120_000), true);
  assert.equal(runtime.isHostileCorporation(THEM, OURS, t0 + 120_000), false, "hostility is one way");
  const [row] = JSON.parse(JSON.stringify(runtime.getOverview().grievances));
  assert.equal(row.total, 2);
  assert.equal(row.byPerson, true, "pilot 10 is not a bot");
});

test("NPCs, corpmates and alliance mates never cause grievances; a forgiven corp stays neutral", () => {
  const { runtime } = grievances();
  assert.equal(runtime.recordAggression({ victimCharacterID: 1, attackerCharacterID: 2 }), null);
  assert.equal(runtime.recordAggression({ victimCharacterID: 1, attackerCharacterID: 11 }), null);
  assert.equal(runtime.recordAggression({ victimCharacterID: 3, attackerCharacterID: 12 }), null);
  assert.equal(runtime.runCommand({ corporationID: OURS, targetCorporationID: THEM, action: "hostile" }).success, true);
  assert.equal(runtime.isHostileCorporation(OURS, THEM), true);
  assert.equal(runtime.hasActiveHostiles(OURS), true);
  runtime.runCommand({ corporationID: OURS, targetCorporationID: THEM, action: "clear" });
  const t0 = Date.now();
  for (let i = 0; i < 4; i += 1) runtime.recordAggression({ victimCharacterID: 1, attackerCharacterID: 10, whenMs: t0 + i * 200_000 });
  assert.equal(runtime.isHostileCorporation(OURS, THEM, t0 + 900_000), false);
  assert.equal(runtime.runCommand({ corporationID: OURS, targetCorporationID: 1000125, action: "war" }).success, false);
});

test("three attacks in a day bring a war declaration through the war authority", async () => {
  const { runtime } = grievances();
  const { deps } = runtime._testing;
  const declared = [];
  deps.warRuntime = () => ({
    chooseWarDirector: () => ({ bot: { characterID: 1 }, session: { characterID: 1 } }),
    ensureWarTreasury: async () => true,
  });
  const t0 = Date.now();
  for (let i = 0; i < 3; i += 1) runtime.recordAggression({ victimCharacterID: 1, attackerCharacterID: 10, whenMs: t0 + i * 200_000 });
  // No war headquarters: no declaration.
  const Module = require("node:module");
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "./playerBotHomeBaseRuntime") return { getHomeBase: () => ({ kind: "structure", stationID: 1035000000001 }) };
    if (request === "../corporation/corpRegistryRuntime") {
      return class { async Handle_DeclareWarAgainst(args) { declared.push(args); } };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    deps.wars = () => ({ listAllWars: () => declared.map(([againstID]) => ({ warID: 7, declaredByID: OURS, againstID })) });
    const result = await runtime.declareGrievanceWars([{ corporationID: OURS }], { now: t0 + 700_000 });
    assert.equal(result.declared, true, result.reason);
    assert.deepEqual(declared, [[THEM, 1035000000001]]);
    const again = await runtime.declareGrievanceWars([{ corporationID: OURS }], { now: t0 + 800_000 });
    assert.equal(again.declared, false, "one attempt per half hour");
  } finally {
    Module._load = original;
  }
});

test("gate campers shoot war targets and criminals anywhere, hostiles only in low and null", () => {
  const source = require("node:fs").readFileSync(path.join(DIR, "playerBotCombatPolicy.js"), "utf8");
  const sandbox = { module: { exports: {} }, Number, Math, String, Array, Object, Set, Map,
    require: (id) => (id === "../../space/npc/pirateFactionPolicy" ? { isPirateFactionEntity: () => false } : require(id)) };
  require("node:vm").runInNewContext(source, sandbox);
  const policy = sandbox.module.exports;
  const ship = (characterID, corporationID) => ({ kind: "ship", itemID: characterID * 10, typeID: 593, position: { x: 0, y: 0, z: 0 }, session: { characterID }, corporationID });
  const context = (security, extra = {}) => ({
    characterID: 1, corporationID: OURS, allianceID: 0, systemSecurity: security, allowManagedBotTargets: true,
    isWarTarget: (id) => id === 20, isCriminal: (id) => id === 21, isSuspect: () => false, isHostile: (id) => id === 22, ...extra,
  });
  assert.equal(policy.isEligibleGateCampTarget(ship(20, THEM), context(0.9)), true, "war target in high-sec");
  assert.equal(policy.isEligibleGateCampTarget(ship(21, THEM), context(0.9)), true, "criminal in high-sec");
  assert.equal(policy.isEligibleGateCampTarget(ship(22, THEM), context(0.9)), false, "hostile in high-sec would be a crime");
  assert.equal(policy.isEligibleGateCampTarget(ship(22, THEM), context(0.3)), true, "hostile in low-sec");
  assert.equal(policy.isEligibleGateCampTarget(ship(23, THEM), context(-0.4)), false, "a neutral passes the camp");
  assert.equal(policy.isEligibleGateCampTarget(ship(20, OURS), context(-0.4)), false, "never a corpmate");
  const chosen = policy.selectCombatTarget([ship(23, THEM), ship(22, THEM)], "gate-camp", context(0.2));
  assert.equal(chosen.itemID, 220);
});
