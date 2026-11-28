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
// Two more per-second costs that grow with pilots living in structures:
// - every space tick rebuilds each structure's scene entity in every active
//   system (cloning its inventory and dogma), even when nothing changed;
// - building that entity counts docked pilots by scanning every character.
// The tick's own projection sync runs at most every STRUCTURE_SYNC_INTERVAL_MS
// per system (other callers, e.g. after a state change, still sync at once),
// and docked counts come from one scan per DOCKED_COUNT_TTL_MS.
const STRUCTURE_SYNC_INTERVAL_MS = 4_000;
const DOCKED_COUNT_TTL_MS = 1_000;
let installed = false;
let sceneInstalled = false;

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
  installDockedCountCache(structureState, now, options.readCharacters);
  installed = true;
  installSceneSyncThrottle(options);
  return true;
}

function installDockedCountCache(structureState, now, readCharacters) {
  if (typeof structureState.countCharactersDockedInStructure !== "function") return;
  const read = readCharacters || (() => {
    const result = require("../../gameStore").read("characters", "/");
    return result && result.success && result.data && typeof result.data === "object" ? result.data : {};
  });
  let counts = null;
  let countedAtMs = 0;
  structureState.countCharactersDockedInStructure = function cachedDockedCount(structureID) {
    const id = Math.trunc(Number(structureID) || 0);
    if (id <= 0) return 0;
    const at = now();
    if (!counts || at - countedAtMs >= DOCKED_COUNT_TTL_MS) {
      counts = new Map();
      for (const record of Object.values(read())) {
        const docked = Math.trunc(Number(record && record.structureID) || 0);
        if (docked > 0) counts.set(docked, (counts.get(docked) || 0) + 1);
      }
      countedAtMs = at;
    }
    return counts.get(id) || 0;
  };
}

// The space runtime loads after bootstrap, so wait for its scene class.
function installSceneSyncThrottle(options = {}) {
  if (sceneInstalled) return;
  const attempt = () => {
    let proto = options.sceneProto || null;
    if (!proto) {
      const key = Object.keys(require.cache).find((file) => /[\\/]space[\\/]runtime[\\/]solarSystemScene\.js$/.test(file));
      const loaded = key && require.cache[key] && require.cache[key].exports;
      const Scene = loaded && (loaded.SolarSystemScene || loaded.default);
      proto = Scene && Scene.prototype;
    }
    if (!proto || typeof proto.syncStructureEntitiesFromState !== "function") return false;
    const original = proto.syncStructureEntitiesFromState;
    const now = options.now || Date.now;
    proto.syncStructureEntitiesFromState = function throttledStructureSync(syncOptions = {}) {
      // Only the runtime tick's call shape, { refresh: false }, is throttled.
      const tickCall = syncOptions && syncOptions.refresh === false && Object.keys(syncOptions).length === 1;
      if (tickCall) {
        const at = now();
        if (this._playerbotsStructureSyncAt && at - this._playerbotsStructureSyncAt < STRUCTURE_SYNC_INTERVAL_MS) {
          return { added: [], updated: [], throttled: true };
        }
        this._playerbotsStructureSyncAt = at;
      }
      return original.call(this, syncOptions);
    };
    sceneInstalled = true;
    return true;
  };
  if (attempt()) return;
  const timer = setInterval(() => { if (attempt()) clearInterval(timer); }, 1_000);
  if (timer.unref) timer.unref();
}

module.exports = { install, MIN_TICK_INTERVAL_MS, STRUCTURE_SYNC_INTERVAL_MS, DOCKED_COUNT_TTL_MS, _testing: { reset: () => { installed = false; sceneInstalled = false; } } };
