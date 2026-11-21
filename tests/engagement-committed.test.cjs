"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const base = "../integration/server/server/src/services/playerbots/";
const { decide } = require(base + "playerBotEngagementPolicy");
const { createProfileCache } = require(base + "playerBotEngagementProfile");
const { createRuntime } = require(base + "playerBotEngagementRuntime")._testing;

const fit = { ready: true, shipID: 11, shipTypeID: 593, modules: [{ itemID: 7, typeID: 12 }],
  droneControlRange: 25_000, totalDrones: 5, shieldCapacity: 2, armorHP: 1, structureHP: 1 };
const state = { inSpace: true, shield: 1, hullDamage: 0, armorDamage: 0, capacitorRatio: 1, warpScrambleStatus: 0 };
const baseline = { fit, state, tankLayer: "shield", deployed: 0, engaged: false, compareStrength: true, ownEhp: 100, targetEhp: 100 };
function choose(mods, memory, now = 5_000) {
  return decide({ ...baseline, ...mods, state: { ...state, ...mods.state }, fit: { ...fit, ...mods.fit } }, memory, now);
}
for (const [name, mods, previous, action] of [
  ["entry at 60%", { state: { shield: 0.6 } }, {}, "continue"],
  ["entry below 60%", { state: { shield: 0.599 } }, {}, "withdraw"],
  ["low for less than 3s", { engaged: true, state: { shield: 0.34 } }, { lowSince: 2001 }, "continue"],
  ["low for 3s", { engaged: true, state: { shield: 0.34 } }, { lowSince: 2000 }, "withdraw"],
  ["35% clears low timer", { engaged: true, state: { shield: 0.35 } }, { lowSince: 0 }, "continue"],
  ["critical below 20%", { engaged: true, state: { shield: 0.199 } }, {}, "withdraw"],
  ["20% starts grace", { engaged: true, state: { shield: 0.20 } }, {}, "continue"],
  ["below recovery", { engaged: true, state: { shield: 0.649 } }, { withdrawing: true }, "withdraw"],
  ["at recovery", { state: { shield: 0.65 } }, { withdrawing: true }, "continue"],
  ["tackled withdrawal", { state: { hullDamage: 0.2, warpScrambleStatus: 1 } }, {}, "clear-tackle"],
  ["shield tank half armor lost", { state: { armorDamage: 0.5 } }, {}, "withdraw"],
  ["armor tank uses live armor", { tankLayer: "armor", engaged: true, state: { shield: 0, armorDamage: 0.3 } }, {}, "continue"],
  ["a 1.8x opponent is eligible before entry", { targetEhp: 180 }, {}, "continue"],
  ["entry at exactly 2x remaining effective HP", { targetEhp: 200 }, {}, "continue"],
  ["withdraw above 2x remaining effective HP", { targetEhp: 200.01 }, {}, "withdraw"],
  ["unknown opponent", { targetEhp: 0 }, {}, "withdraw"],
  ["no mid-fight strength veto", { targetEhp: 900, engaged: true }, {}, "continue"],
  ["empty bay and space", { fit: { totalDrones: 0 } }, {}, "withdraw"],
  ["last deployed drone", { fit: { totalDrones: 0 }, deployed: 1 }, {}, "continue"],
  ["active capacitor low", { fit: { capacitorUsePerSecond: 1 }, state: { capacitorRatio: 0.149 } }, {}, "withdraw"],
  ["passive capacitor low", { state: { capacitorRatio: 0 } }, {}, "continue"],
]) test(name, () => assert.equal(choose(mods, previous).action, action));

function estimate(typeID, entity, snapshot = fit) {
  const c = entity.conditionState || { shieldCharge: 1, armorDamage: 0, damage: 0 };
  return c.shieldCharge * snapshot.shieldCapacity + (1 - c.armorDamage) * snapshot.armorHP + (1 - c.damage) * snapshot.structureHP;
}
test("cache uses ship and ordered fitting, ignores damage, invalidates changed hardware or effective attributes", () => {
  const cache = createProfileCache(estimate);
  const modules = [...fit.modules, { itemID: 8, typeID: 14 }];
  const profile = cache.getProfile({ ...fit, modules });
  assert.equal(profile.maxEhp, 4);
  assert.equal(profile.orbitMeters, 12_500);
  assert.equal(profile.tankLayer, "shield");
  assert.equal(cache.getProfile({ ...fit, modules: modules.toReversed(), liveShield: 0.2, totalDrones: 0 }), profile);
  assert.notEqual(cache.getProfile({ ...fit, modules: [{ itemID: 9, typeID: 14 }] }), profile);
  assert.equal(cache.getProfile({ ...fit, modules, armorHP: 4 }).tankLayer, "armor");
  for (let i = 0; i <= 500; i++) cache.getProfile({ ...fit, shipID: 100 + i });
  assert.notEqual(cache.getProfile({ ...fit, modules }), profile);
});

function fixture(env = {}) {
  const calls = [];
  const entity = { itemID: 11, typeID: 593, mode: "STOP", maxTargetRange: 25_000 };
  const target = { itemID: 22, typeID: 593 };
  const scene = { getEntityByID: () => target, getTargetsForEntity: () => [],
    getSortedPendingTargetLocks: () => [{ targetID: 22 }] };
  const input = { bot: { characterID: 5 }, operation: { kind: "combat", mode: "war" },
    attached: { entity, scene, session: {} }, target, distance: 1_000, fit: { ...fit }, state: { ...state },
    stance: "committed", rangePolicy: "control", drones: [{ itemID: 33, targetID: 22 }],
    cadence: { closingMs: 15_000, engagedMs: 15_000 } };
  const world = { time: 1000, human: true, pause: false };
  const done = () => ({ success: true });
  const deps = { orbit(s, id, range) { calls.push(["orbit", id, range]); }, sceneHasHumanPilot: () => world.human,
    loadController: { shouldPauseLowPriorityWork: () => world.pause },
    space: { approach(b, id, range) { calls.push(["follow", id, range]); return done(); },
      warp() { calls.push(["warp"]); return done(); }, getActorSpace: done, getSpaceState: done,
      lockTarget() { calls.push(["lock"]); return done(); } },
    combat: { estimateEffectiveHitPoints: estimate, getControlledDrones: () => input.drones, launchDrones: done },
    drone: { commandEngage: done, commandReturnBay: done }, logger: { info() {}, warn() {}, debug() {} },
    telemetry: { recordWork() {} } };
  const runtime = createRuntime({ dependencies: deps, env, now: () => world.time });
  return { world, runtime, input, entity, calls, deps, scene };
}
test("C and D defer to the host for cautious patrols, escorts, sites and other operations", () => {
  const { runtime } = fixture();
  for (const seam of ["C", "D"]) {
    for (const op of [{ mode: "security" }, { mode: "piracy" }, { mode: "war", miningEscortGroupKey: "4:5" },
      { mode: "war", siteInstanceID: 4 }, { mode: "war", kind: "mine" }]) {
      assert.equal(runtime.handles(seam, { kind: "combat", ...op }, { wildfire: true }, false), false);
    }
    assert.equal(runtime.handles(seam, { kind: "combat", mode: "piracy" }, { wildfire: true }, true), true);
  }
});
test("C and D share hysteresis for the same hull, honor operator and legality, and expire memory", () => {
  const { input, runtime, world } = fixture();
  input.roleFitReady = input.eligible = true;
  input.state.shield = 0.32;
  assert.equal(runtime.runSeamD(input).action, "engage");
  world.time += 3000;
  assert.equal(runtime.runSeamC(input).action, "withdraw");
  input.state.shield = 0.64;
  assert.equal(runtime.runSeamD(input).action, "evade");
  world.time += 30 * 60_000;
  assert.equal(runtime.runSeamD(input).action, "engage");
  input.operation.withdrawRequested = true;
  assert.equal(runtime.runSeamC(input).safe, false);
  input.operation.withdrawRequested = false;
  input.state.shield = 1;
  input.roleFitReady = false;
  assert.equal(runtime.runSeamD(input).action, "evade");
  input.roleFitReady = true;
  input.eligible = false;
  assert.equal(runtime.runSeamD(input).action, "evade");
});
test("committed movement uses mode-specific distance, deadband, pending locks and warp", () => {
  const { runtime, input, calls, entity } = fixture();
  for (const distance of [19_000, 16_000, 14_000]) {
    input.distance = distance;
    runtime.runSeamA(input);
  }
  assert.deepEqual(calls, [["follow", 22, 12_500], ["orbit", 22, 12_500]]);
  Object.assign(entity, { mode: "ORBIT", targetEntityID: 22, orbitDistance: 12_500, followRange: 0 });
  assert.equal(runtime.runSeamA(input).status, "engaging");
  assert.equal(calls.length, 2);
});
test("cross-grid pursuit recalls once, waits for the bay and never launches in transit", () => {
  const { runtime, input, calls, deps } = fixture();
  deps.drone.commandReturnBay = (_, ids) => { calls.push(["recall", ...ids]); };
  deps.combat.launchDrones = () => { throw new Error("Launched before arrival"); };
  input.distance = 150_001;
  assert.equal(runtime.runSeamA(input).reason, "recalling-before-warp");
  input.drones[0].droneCommand = "RETURN_BAY";
  assert.equal(runtime.runSeamA(input).reason, "recalling-before-warp");
  input.drones = [];
  assert.equal(runtime.runSeamA(input).reason, "warping");
  input.state.busy = true;
  input.distance = 149_000;
  assert.equal(runtime.runSeamA(input).reason, "in-transit");
  assert.deepEqual(calls, [["recall", 33], ["warp"]]);
  assert.equal(runtime.status().errors, 0);
});
test("committed fleet can orbit while its own lock is pending but must not launch until that lock completes", () => {
  const { runtime, input, calls, scene } = fixture();
  Object.assign(input, { operation: { kind: "fleet-attack", mode: "war" }, lock: true, drones: [] });
  const flight = [{ itemID: 33, targetID: 22 }];
  input.fleetDrones = { launch() { calls.push(["launch"]); return { success: true, drones: flight }; }, read: () => flight };
  assert.equal(runtime.runSeamB(input).reason, "lock-pending");
  assert.deepEqual(calls, [["orbit", 22, 12_500]]);
  scene.getTargetsForEntity = () => [22];
  assert.equal(runtime.runSeamB(input).status, "engaging");
  assert.deepEqual(calls.at(-1), ["launch"]);
});
test("fast slots cap and expire, and require both a human observer and an available load guard", () => {
  const { runtime, world, input, deps } = fixture();
  for (let i = 1; i <= 13; i++) {
    input.bot.characterID = i;
    assert.equal(runtime.runSeamA(input).delayMs, i <= 12 ? 2000 : 15000);
  }
  assert.equal(runtime.status().fastSlots, 12);
  world.time += 30_000;
  assert.equal(runtime.status().fastSlots, 0);
  for (const [human, pause, delay] of [[false, false, 15000], [true, true, 15000], [true, false, 2000]]) {
    Object.assign(world, { human, pause });
    assert.equal(runtime.runSeamA(input).delayMs, delay);
  }
  delete deps.loadController;
  assert.equal(runtime.runSeamA(input).delayMs, 15000);
  assert.equal(runtime.status().fastSlots, 0);
});
