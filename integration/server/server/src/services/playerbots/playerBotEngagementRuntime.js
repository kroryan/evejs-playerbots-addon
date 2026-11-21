"use strict";

// Called only at the ENGAGEMENT-SEAM markers. Set EVEJS_PLAYER_BOTS_ENGAGEMENT=0
// to use the original host paths, including the independent surface-distance fix.
const REQUIRED = {
  space: ["getActorSpace", "getSpaceState", "approach", "warp", "lockTarget"],
  combat: ["getControlledDrones", "launchDrones", "estimateEffectiveHitPoints"],
  drone: ["commandEngage", "commandReturnBay"],
  telemetry: ["recordWork"],
  logger: ["info", "debug", "warn"],
};

function maneuverDependencies() {
  const ShipService = require("../ship/beyonceService");
  if (typeof ShipService.prototype.Handle_CmdOrbit !== "function") throw new Error("Handle_CmdOrbit missing");
  let sceneHasHumanPilot, loadController;
  try { ({ sceneHasHumanPilot } = require("./playerBotUnobservedScenePolicy")); }
  catch (_) { /* No fast cadence without an observer check. */ }
  try { loadController = require("./playerBotLoadController").getPlayerBotLoadController(); }
  catch (_) { /* No fast cadence without a load guard. */ }
  return {
    orbit: (session, id, meters) => new ShipService().Handle_CmdOrbit([id, meters], session),
    sceneHasHumanPilot, loadController,
  };
}

function hostDependencies(logger) {
  return {
    space: require("./playerBotSpaceRuntime"),
    combat: require("./playerBotCombatRuntime"),
    drone: require("../drone/droneRuntime"),
    telemetry: require("./playerBotPerformanceTelemetry").getTelemetry(),
    logger,
  };
}

function rangesFor(fit, entity, rangePolicy, lock) {
  let engageRange, approachTo;
  if (rangePolicy === "legacy") {
    const effective = Math.max(1_000, Math.min(15_000,
      Number(fit.droneAttackRange) || 15_000, Number(fit.droneControlRange) || 15_000));
    engageRange = effective * 0.8;
    approachTo = Math.min(15_000, effective * 0.7);
  } else {
    engageRange = (Number(fit.droneControlRange) || 20_000) * 0.8;
    approachTo = Math.max(1_000, Math.min(15_000, engageRange * 0.7));
  }
  let lockCap = Infinity;
  if (lock) {
    lockCap = (Number(entity.maxTargetRange) || engageRange) * 0.8;
    engageRange = Math.min(engageRange, lockCap);
    approachTo = Math.min(approachTo, engageRange * 0.9);
  }
  if (!(approachTo < engageRange)) approachTo = engageRange * 0.7;
  const commandRange = Math.max(1_000, Math.trunc(approachTo));
  const feasible = commandRange < lockCap;
  const floorAdjusted = feasible && commandRange >= engageRange;
  if (floorAdjusted) engageRange = Math.min(commandRange + 250, lockCap);
  return { engageRange, approachTo, commandRange, lockCap, feasible, floorAdjusted };
}

function readDrones(input, deps) {
  return input.fleetDrones ? input.fleetDrones.read()
    : deps.combat.getControlledDrones(input.attached.scene, input.attached.entity.itemID);
}

function report(status, delayMs, reason = null, detail = null) {
  return { status, reason, justEngaged: false, delayMs, detail };
}

function assignedDroneCount(drones, targetID) {
  return drones.filter((drone) => Number(drone.targetID) === targetID).length;
}

function confirmedEngagement(input, drones) {
  const droneCount = assignedDroneCount(drones, Number(input.target.itemID));
  if (!droneCount) return null;
  return { ...report("engaging", input.cadence.engagedMs), justEngaged: true, droneCount };
}

function requiresPursuitWarp(distance) {
  return distance > 150_000;
}

function maneuver(input, deps, distance, range, step) {
  const { bot, attached: { scene, entity, session }, target, cadence } = input;
  const id = Number(target.itemID);
  const space = input.space || deps.space;
  if (requiresPursuitWarp(distance)) {
    if (!input.state.busy && !scene.hasQueuedMovementChange?.(entity)) {
      step.command = "warp";
      const moved = space.warp(bot, id);
      if (!moved.success) return report("closing", moved.blocked ? 60_000 : cadence.closingMs, "warp-deferred", moved.message);
    }
    return report("closing", cadence.closingMs, "warping");
  }
  const meters = Math.min(Math.max(1_000, Math.trunc(step.profile.orbitMeters)), Math.ceil(range.engageRange) - 1);
  const mode = distance > meters * 1.5 ? "FOLLOW" : distance <= meters * 1.2 ? "ORBIT" : null;
  if (!mode || input.state.busy || scene.hasQueuedMovementChange?.(entity)) return null;
  const current = mode === "FOLLOW" ? entity.followRange : entity.orbitDistance;
  if (entity.mode === mode && Number(entity.targetEntityID) === id && Math.abs(current - meters) <= 1) return null;
  if (mode === "FOLLOW") {
    step.command = "approach";
    const moved = space.approach(bot, id, meters);
    if (!moved.success && moved.message !== "ThrottleGeneric") {
      return report("refused", cadence.closingMs, "approach-failed", moved.message);
    }
  } else {
    step.command = "orbit";
    try { deps.orbit(session, id, meters); }
    catch (error) {
      if (![error?.message, error?.code, error?.errorMsg, error?.msg].includes("ThrottleGeneric")) throw error;
    }
  }
  return null;
}

function engageWithDrones(input, deps, step) {
  const { bot, attached, target, fit, cadence } = input;
  const { scene, entity, session } = attached;
  const targetID = Number(target && target.itemID);
  if (!targetID || !scene.getEntityByID(targetID)) return report("target-lost", cadence.closingMs);
  let drones = input.drones;
  function launch() {
    step.command = "launch";
    const result = input.fleetDrones ? input.fleetDrones.launch()
      : deps.combat.launchDrones(bot, session, scene, entity.itemID, input.operation.combatDroneTypeID);
    if (!result.success) return report("no-weapon", cadence.closingMs, null, result.message);
    drones = result.drones;
    return null;
  }
  if (!input.lock && !step.profile && !drones.length) {
    const failure = launch();
    if (failure) return failure;
  }

  const range = rangesFor(fit, entity, input.rangePolicy, input.lock);
  if (!range.feasible) return report("refused", cadence.closingMs, "lock-range-infeasible",
    `commandRange ${range.commandRange} >= lockCap ${Math.trunc(range.lockCap)}`);
  if (range.floorAdjusted) step.noteFloor();
  const distance = input.distance === undefined ? input.state.distanceTo(targetID) : input.distance;
  if (!Number.isFinite(distance)) return report("target-lost", cadence.closingMs);
  const space = input.space || deps.space;
  if (step.profile) {
    if (input.state.busy) return report("closing", cadence.closingMs, "in-transit");
    if (!input.lock && requiresPursuitWarp(distance) && drones.length) {
      const outstanding = drones.filter((drone) => drone.droneCommand !== "RETURN_BAY");
      if (outstanding.length) {
        step.command = "recall";
        deps.drone.commandReturnBay(session, outstanding.map((drone) => Number(drone.itemID)));
      }
      return report("closing", cadence.closingMs, "recalling-before-warp");
    }
    const movement = maneuver(input, deps, distance, range, step);
    if (movement) return movement;
    if (!input.lock && !drones.length) {
      const failure = launch();
      if (failure) return failure;
    }
  }
  if (distance > range.engageRange) {
    const following = entity.mode === "FOLLOW" && Number(entity.targetEntityID) === targetID &&
      Math.abs((Number(entity.followRange) || 0) - range.commandRange) <= 1;
    if (!step.profile && !following) {
      step.command = "approach";
      const moved = space.approach(bot, targetID, range.commandRange);
      if (!moved.success && moved.message !== "ThrottleGeneric") {
        return report("refused", cadence.closingMs, "approach-failed", moved.message);
      }
    }
    const closing = report("closing", cadence.closingMs);
    const controlRange = Number(fit.droneControlRange);
    if (!input.lock && Number.isFinite(controlRange) && distance <= controlRange) {
      // Native retaliation can precede the hull reaching its own firing threshold.
      closing.droneCount = assignedDroneCount(drones, targetID);
    }
    return closing;
  }

  if (input.lock || step.profile) {
    const locked = typeof scene.getTargetsForEntity === "function" &&
      scene.getTargetsForEntity(entity).some((id) => Number(id) === targetID);
    if (!locked) {
      const pending = scene.getSortedPendingTargetLocks?.(entity)?.some((entry) => Number(entry.targetID) === targetID);
      if (!pending) {
        step.command = "lock";
        const result = space.lockTarget(bot, targetID);
        if (input.lock && !result.success) return report("closing", cadence.closingMs, "lock-refused", result.errorMsg || result.message);
      }
      if (input.lock) return report("closing", cadence.closingMs, "lock-pending");
    }
    if (!drones.length) {
      const failure = launch();
      if (failure) return failure;
    }
  }
  if (drones.some((drone) => Number(drone.targetID) === targetID)) return report("engaging", cadence.engagedMs);
  const droneIDs = drones.map((drone) => Number(drone.itemID));
  if (input.beforeEngage) {
    try { input.beforeEngage(); }
    catch (error) { step.noteHook(error); }
  }
  step.command = "engage";
  const response = (input.drone || deps.drone).commandEngage(session, droneIDs, targetID);
  const confirmed = confirmedEngagement(input, readDrones(input, deps));
  if (confirmed) return confirmed;
  const entries = JSON.stringify(response && response.entries || [], (_, value) =>
    typeof value === "bigint" ? String(value) : value);
  return report("refused", cadence.engagedMs, "engage-refused", entries.slice(0, 180));
}

function createRuntime({ dependencies, now = Date.now, env = process.env } = {}) {
  let deps, logger, unavailable = false, tripped = false, errors = 0, floorLogged = false;
  let errorTimes = [];
  let profiles, decide;
  const seamsTaken = { A: 0, B: 0, C: 0, D: 0 };
  const recentLogs = new Map();
  const memory = new Map(), slots = new Map();
  const setting = (name, fallback, min) => {
    const raw = env[name];
    const value = Number(raw);
    return raw != null && String(raw).trim() && Number.isSafeInteger(value) && value >= min ? value : fallback;
  };
  const fastMs = setting("EVEJS_PLAYER_BOTS_ENGAGEMENT_FAST_MS", 2_000, 1_000);
  const maxSlots = setting("EVEJS_PLAYER_BOTS_ENGAGEMENT_FAST_SLOTS", 12, 0);

  // Both maps are kept in renewal order. Cleanup is lazy and needs no timer.
  function expire(map, time, ttl) {
    for (const [key, entry] of map) {
      if (time - entry.at < ttl) break;
      map.delete(key);
    }
  }
  function keyFor(input) {
    return `${input.bot.characterID}:${input.fit.shipID || input.attached?.entity.itemID || input.state.shipID}`;
  }
  function cadence(input, result) {
    const key = keyFor(input), time = now();
    expire(slots, time, 30_000);
    const held = slots.delete(key);
    if (["engaging", "closing"].includes(result.status) && result.reason !== "warp-deferred" &&
        slots.size < maxSlots && deps.sceneHasHumanPilot?.(input.attached.scene) === true &&
        deps.loadController?.shouldPauseLowPriorityWork?.() === false) {
      slots.set(key, { at: time });
      result.delayMs = fastMs;
    }
    if (held || slots.has(key)) deps.telemetry.recordWork("engagement.fastSlots", 0, { items: slots.size });
  }

  function decision(input, compareStrength) {
    const { fit, state, operation, target, drones } = input;
    const key = keyFor(input), time = now();
    expire(memory, time, 30 * 60_000);
    const previous = memory.get(key);
    let forcedReason = null;
    if (operation.withdrawRequested || operation.emergencyRetreat || operation.stage === "return") {
      forcedReason = operation.withdrawReason || "withdrawal-in-progress";
    } else if (input.hostSafety?.reason === "ship-unavailable") {
      forcedReason = input.hostSafety.reason;
    } else if (input.eligible === false || input.roleFitReady === false) {
      forcedReason = input.eligible === false ? "target-not-legally-engageable" : "validated-combat-fit-unavailable";
    } else if (fit.ready === false) {
      // A partially lost flight makes the host snapshot unready. The remaining
      // drones can still fight. Preserve other fitting/authority failures.
      const problems = fit.readinessProblems || [];
      if (!problems.length || problems.some((p) => p !== "required combat drones are missing from the drone bay")) {
        forcedReason = problems.join("; ") || "combat-fit-not-ready";
      }
    }
    const usable = Array.isArray(fit.modules) && fit.shipID > 0 && fit.droneControlRange > 0;
    if (!usable) forcedReason ||= "combat-fit-not-ready";
    const tankLayer = usable ? profiles.getProfile(fit).tankLayer : "shield";
    const engaged = drones.some((drone) => Number(drone.targetID) > 0 && Number(drone.targetID) !== Number(fit.shipID) &&
      (!target || Number(drone.targetID) === Number(target.itemID)));
    let ownEhp, targetEhp;
    if (compareStrength && !engaged && !forcedReason) {
      const own = input.attached.entity;
      ownEhp = deps.combat.estimateEffectiveHitPoints(own.typeID, own, fit);
      targetEhp = deps.combat.estimateEffectiveHitPoints(target.typeID, target);
    }
    const verdict = decide({ state, fit, tankLayer, engaged, deployed: drones.length,
      forcedReason, compareStrength, ownEhp, targetEhp }, previous?.value, time);
    memory.delete(key);
    memory.set(key, { at: time, value: verdict.memory });
    if (verdict.action !== "continue") slots.delete(key);
    return verdict;
  }

  function log(level, message) {
    try { (logger || console)[level](`[PB-ENGAGE] ${message}`); }
    catch (_) { /* Logging must not change a combat order. */ }
  }
  function warnOnce(message, key = message) {
    const time = now();
    for (const [loggedKey, expires] of recentLogs) if (expires <= time) recentLogs.delete(loggedKey);
    if (recentLogs.has(key)) return;
    recentLogs.set(key, time + 60_000);
    log("warn", message);
  }
  function noteError(seam, error) {
    const time = now();
    errors++;
    errorTimes = errorTimes.filter((prior) => prior > time - 600_000);
    errorTimes.push(time);
    const message = String(error?.message ?? error);
    warnOnce(`seam ${seam}: ${message}`, `module: ${message}`);
    if (!tripped && errorTimes.length >= 20) {
      tripped = true;
      log("info", "Circuit opened after 20 errors in ten minutes; disabled until restart.");
    }
  }
  function enabled() {
    if (env.EVEJS_PLAYER_BOTS_ENGAGEMENT === "0" || unavailable || tripped) return false;
    if (deps) return true;
    try {
      logger = dependencies ? dependencies.logger : require("../../utils/logger");
      const candidate = dependencies || hostDependencies(logger);
      for (const [group, names] of Object.entries(REQUIRED)) {
        for (const name of names) {
          if (typeof candidate[group]?.[name] !== "function") throw new Error(`${group}.${name} missing`);
        }
      }
      deps = candidate;
      return true;
    } catch (error) {
      unavailable = true;
      if (typeof logger?.info !== "function") logger = console;
      log("info", `Host dependency unavailable; using host paths. ${error?.message ?? error}`);
      return false;
    }
  }
  function committedEnabled() {
    if (!enabled()) return false;
    if (profiles) return true;
    try {
      if (!dependencies) Object.assign(deps, maneuverDependencies());
      ({ decide } = require("./playerBotEngagementPolicy"));
      profiles = require("./playerBotEngagementProfile").createProfileCache(deps.combat.estimateEffectiveHitPoints);
      return true;
    } catch (error) {
      unavailable = true;
      log("info", `Committed maneuver dependency unavailable; using host paths. ${error?.message ?? error}`);
      return false;
    }
  }
  function handles(seam, operation, bot, playerTarget = false) {
    if (seam === "C" || seam === "D") {
      return operation?.kind === "combat" && !operation.siteInstanceID && !operation.miningEscortGroupKey &&
        (operation.mode === "war" || operation.mode === "nullsec-conflict" ||
          (operation.mode === "piracy" && bot?.wildfire === true && playerTarget === true)) && committedEnabled();
    }
    const applicable = seam === "A" ? operation?.kind === "combat" && !operation.siteInstanceID
      : seam === "B" && operation?.kind === "fleet-attack";
    return applicable && enabled();
  }
  function noteFloor() {
    if (floorLogged) return;
    floorLogged = true;
    log("debug", "range-floor: raised the engagement gate above the minimum follow range.");
  }
  function noteHook(error) { warnOnce(`beforeEngage: ${error?.message ?? error}`); }

  function run(seam, input) {
    if (!handles(seam, input.operation, input.bot, input.playerTarget)) return null;
    if (input.stance === "committed" && !committedEnabled()) return null;
    const started = performance.now();
    const step = { command: null, noteFloor, noteHook };
    let result;
    try {
      if (seam === "C" || seam === "D") {
        const verdict = decision(input, seam === "D");
        const safe = verdict.action === "continue";
        const action = seam === "D" ? (safe ? "engage" : "evade")
          : verdict.action === "clear-tackle" ? "clear-tackle-and-withdraw" : verdict.action;
        result = { safe, action, reason: verdict.reason };
      } else {
        if (input.stance === "committed") {
          step.profile = profiles.getProfile(input.fit);
          if (input.checkEntry) {
            const verdict = decision(input, true);
            if (verdict.action !== "continue") result = report("withdraw", input.cadence.closingMs, verdict.reason);
          }
        }
        result ||= engageWithDrones(input, deps, step);
        if (step.profile) {
          try { cadence(input, result); }
          catch (error) { warnOnce(`fast cadence unavailable: ${error?.message ?? error}`); }
        } else if (slots.size) slots.delete(keyFor(input));
      }
    } catch (error) {
      noteError(seam, error);
      if (!step.command) return null;
      // A synchronous authority can throw after changing world state. Returning null here
      // would immediately replay the same order in the original host block.
      if (step.command === "engage") {
        try {
          result = confirmedEngagement(input, readDrones(input, deps));
        } catch (_) { /* The next host step revalidates the target and drones. */ }
      }
      result ||= report("closing", input.cadence.closingMs);
    } finally {
      try { deps.telemetry.recordWork(`engagement.seam${seam}`, performance.now() - started); }
      catch (error) { warnOnce(`telemetry: ${error?.message ?? error}`); }
    }
    if (++seamsTaken[seam] === 1) log("info", `First engagement at seam ${seam}.`);
    log("debug", `seam ${seam}: ${result.status || result.action}${result.reason ? " " + result.reason : ""}`);
    return result;
  }

  return {
    handles, requiresPursuitWarp,
    runSeamA: (input) => run("A", input),
    runSeamB: (input) => run("B", input),
    runSeamC: (input) => run("C", input),
    runSeamD: (input) => run("D", input),
    status() {
      expire(slots, now(), 30_000);
      return { enabled: enabled(), tripped, errors, seamsTaken: { ...seamsTaken },
        fastSlots: slots.size, fastMs, maxSlots };
    },
  };
}

module.exports = { ...createRuntime(), _testing: { createRuntime, rangesFor } };
