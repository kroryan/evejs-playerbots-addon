"use strict";

// The host EHP estimator accepts remaining layer fractions. Isolate each tank
// layer without copying Dogma resistance rules or caching a damaged ship.
function createProfileCache(estimateEffectiveHitPoints) {
  const entries = new Map();
  function getProfile(fit) {
    const signature = fit.modules.map(({ itemID, typeID }) => `${itemID}:${typeID}`).sort().join(",");
    const key = `${fit.shipID}:${signature}`;
    const controlRange = Number(fit.droneControlRange);
    const cached = entries.get(key);
    // A skill change can alter fitted attributes without replacing a module.
    const attributes = [fit.shipTypeID, controlRange, fit.shieldCapacity, fit.armorHP, fit.structureHP].join("/");
    if (cached && cached.attributes === attributes) return cached.profile;
    const ehp = (shieldCharge, armorDamage, damage) => estimateEffectiveHitPoints(
      fit.shipTypeID, { conditionState: { shieldCharge, armorDamage, damage } }, fit);
    const shieldEhp = ehp(1, 1, 1);
    const armorEhp = ehp(0, 0, 1);
    const profile = Object.freeze({
      signature, weapon: "drone", controlRange, engageRange: controlRange * 0.8,
      orbitMeters: Math.min(controlRange * 0.5, 20_000),
      tankLayer: shieldEhp >= armorEhp ? "shield" : "armor",
      maxEhp: shieldEhp + armorEhp + ehp(0, 1, 0),
    });
    if (!cached && entries.size >= 500) entries.delete(entries.keys().next().value);
    entries.set(key, { attributes, profile });
    return profile;
  }
  return { getProfile };
}

module.exports = { createProfileCache };
