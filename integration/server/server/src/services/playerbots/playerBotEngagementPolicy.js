"use strict";

const MAX_OPPONENT_EHP_RATIO = 2.0;

// Pure decision shared by the patrol and its asynchronous incoming-hit path.
// Only an observed assignment counts as fighting; selection alone is not a hit.
function decide(input, previous = {}, now) {
  const { state, fit, tankLayer, engaged } = input;
  const tank = tankLayer === "armor" ? 1 - state.armorDamage : state.shield;
  const lowSince = tank < 0.35 ? (previous.lowSince ?? now) : null;
  const withdraw = (reason) => ({
    action: state.warpScrambleStatus > 0 ? "clear-tackle" : "withdraw",
    reason, memory: { withdrawing: true, lowSince },
  });

  if (input.forcedReason) return withdraw(input.forcedReason);
  if (!state.inSpace || state.isCapsule) return withdraw("ship-unavailable");
  if (state.hullDamage >= 0.20) return withdraw("structure-damage");
  if (tankLayer === "shield" && state.armorDamage >= 0.50) return withdraw("shield-tank-armor-damage");
  if (!(Math.max(fit.totalDrones || 0, input.deployed) > 0)) return withdraw("no-combat-drones");
  if (fit.capacitorUsePerSecond > 0 && state.capacitorRatio < 0.15) return withdraw("active-capacitor-low");
  if (tank < 0.20) return withdraw("tank-critical");
  if (lowSince !== null && now - lowSince >= 3_000) return withdraw("tank-low-for-three-seconds");
  if (previous.withdrawing && tank < 0.65) return withdraw("recovering-before-reentry");
  if (!engaged && tank < 0.60) return withdraw("entry-reserve-low");
  if (!engaged && input.compareStrength) {
    if (!(input.ownEhp > 0 && input.targetEhp > 0)) return withdraw("opponent-strength-unknown");
    if (input.targetEhp > input.ownEhp * MAX_OPPONENT_EHP_RATIO) return withdraw("opponent-too-strong");
  }
  return { action: "continue", reason: "committed-reserves-healthy", memory: { withdrawing: false, lowSince } };
}

module.exports = { decide };
