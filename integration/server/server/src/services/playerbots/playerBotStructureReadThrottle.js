"use strict";

// structureState.getStructureByID() runs a full structure tick (every
// structure's timers, fuel and fitted service modules, cloning their
// inventory) on every read unless the caller passes { refresh: false }.
// worldData.getStructureByID() always refreshes. Once thousands of pilots
// live and shop in Upwell structures, the director and operations read
// structures thousands of times a pass and the server stalls for minutes.
// This keeps reads refreshing, but runs the tick at most once per interval;
// the structure clock itself is unchanged.

const MIN_TICK_INTERVAL_MS = 2_000;
let installed = false;

function install(options = {}) {
  if (installed) return false;
  const structureState = options.structureState || require("../structure/structureState");
  const original = structureState.getStructureByID;
  if (typeof original !== "function") return false;
  const now = options.now || Date.now;
  let lastTickAtMs = 0;
  structureState.getStructureByID = function throttledGetStructureByID(structureID, readOptions = {}) {
    const wantsRefresh = !readOptions || readOptions.refresh !== false;
    let refresh = false;
    if (wantsRefresh) {
      const at = now();
      if (at - lastTickAtMs >= MIN_TICK_INTERVAL_MS) {
        lastTickAtMs = at;
        refresh = true;
      }
    }
    return original.call(this, structureID, { ...(readOptions || {}), refresh });
  };
  installed = true;
  return true;
}

module.exports = { install, MIN_TICK_INTERVAL_MS, _testing: { reset: () => { installed = false; } } };
