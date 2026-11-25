"use strict";

/*
 * Corporation deposit: when a corporation's pilot finishes a mining or PI job,
 * the goods are taken to the corporation's headquarters and handed to the
 * corporation instead of being sold.
 *
 * Wiring in playerBotOperationRuntime.js (all additive):
 *   - baseOperation() calls decorateOperation(): a new mine / pi-collect job of
 *     a deposit-enabled corporation is marked depositToCorporation, mining stops
 *     selling, and PI collection delivers to the HQ instead of the market hub.
 *   - advanceOperation() calls shouldDeposit()/begin() when such a job reaches
 *     "completed": the job goes back to "active" in the "corp-deposit" stage, so
 *     the director cannot give the pilot other work before the goods are handed
 *     over.
 *   - advanceMining() and advancePlanetaryCollection() hand the stage to
 *     advance(), which hauls any goods left at the job's stations to the HQ,
 *     transfers them to the corporation and then finishes the job.
 *
 * Where the corporation receives the goods (per corporation, /bots corp deposit):
 *   deliveries - "Corporation Deliveries" at the HQ station. The client lists it
 *                at the station itself and in the corporation Assets window, so
 *                it can be reached from inside and outside the station.
 *   hangar <n> - corporation office hangar division 1-7 at the HQ station, when
 *                the corporation rents an office there; otherwise deliveries.
 *
 * Which corporations deposit: an explicit /bots corp deposit on|off wins;
 * otherwise a corporation deposits once it has an HQ saved with /bots corp hq
 * set. A /bots corp work order always deposits unless deposit is set to off.
 * Industry-cycle output has its own delivery path and is not changed here.
 * Contributed by Luna.
 */

const DEPOSIT_KINDS = new Set(["mine", "pi-collect"]);
// Ore, minerals and planetary goods: what mining and PI collection produce.
// Modules and charges stay with the pilot, who may need them for a refit.
const DEPOSIT_CATEGORIES = new Set([4, 25, 42, 43]);
const FLAG_CORP_DELIVERIES = 62;
const FLAG_CORP_HANGAR_1 = 115;
const STAGE = "corp-deposit";
const MAX_FAILED_PASSES = 4;
const SETTINGS_TABLE = "playerBots";
const SETTINGS_PATH = "/_corpDeposit";

function load(relativePath) {
  return require(`../../${relativePath}`);
}

// Settings live in the game store next to the corporation HQs saved by
// /bots corp hq, so backups and resets treat them the same way.
function defaultStore() {
  const repo = load("gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
  return {
    read() {
      repo.ensureTable(SETTINGS_TABLE);
      const result = repo.read(SETTINGS_TABLE, SETTINGS_PATH);
      return result.success && result.data && typeof result.data === "object" ? { ...result.data } : {};
    },
    write(value) {
      repo.ensureTable(SETTINGS_TABLE);
      const result = repo.write(SETTINGS_TABLE, SETTINGS_PATH, value);
      if (!result || !result.success) throw new Error(result && result.errorMsg || "PLAYERBOT_CORP_DEPOSIT_WRITE_FAILED");
      if (typeof repo.flushTableSync === "function") repo.flushTableSync(SETTINGS_TABLE);
    },
  };
}

function defaultDeps() {
  return {
    itemStore: () => load("services/inventory/itemStore"),
    registry: () => load("services/inventory/itemTypeRegistry"),
    corporations: () => load("services/corporation/corporationRuntimeState"),
    headquarters: () => require("./playerBotCorpCommands"),
    log: () => load("utils/logger"),
    store: defaultStore,
    hangars: () => require("./playerBotCorpHangarRuntime"),
  };
}

const state = { deps: defaultDeps(), settings: null, forced: new Set() };

function configure(overrides = {}) {
  state.deps = { ...defaultDeps(), ...overrides };
  state.settings = null;
  state.forced.clear();
}

function reset() {
  state.deps = defaultDeps();
  state.settings = null;
  state.forced.clear();
}

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function warn(message) {
  try { state.deps.log().warn(`[CorpDeposit] ${message}`); } catch (error) { /* logger unavailable */ }
}

// ------------------------------------------------------------- settings

function readSettings() {
  if (!state.settings) state.settings = state.deps.store().read() || {};
  return state.settings;
}

function getSettings(corporationID) {
  const raw = readSettings()[String(positive(corporationID))] || {};
  const division = positive(raw.division);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
    // Corporation hangars by default: Deliveries cannot be opened in EveJS.
    // Deliveries only when chosen by hand since then (older saves wrote it
    // as the default).
    target: raw.target === "deliveries" && raw.deliveriesChosen === true ? "deliveries" : "hangar",
    deliveriesChosen: raw.deliveriesChosen === true,
    division: division >= 1 && division <= 7 ? division : 1,
    // Without a chosen division each kind of work has its own
    // (playerBotCorpHangarRuntime.js): mining 1, planetary 2.
    explicitDivision: raw.target === "hangar" && division >= 1 && division <= 7,
  };
}

function updateSettings(corporationID, patch) {
  const id = String(positive(corporationID));
  const merged = { ...getSettings(corporationID), ...patch };
  const next = { ...readSettings() };
  if (merged.enabled === null && merged.target === "hangar" && !merged.explicitDivision && patch.division === undefined) delete next[id];
  else {
    next[id] = {
      enabled: merged.enabled,
      target: merged.target,
      division: patch.division !== undefined || merged.explicitDivision ? merged.division : 0,
      deliveriesChosen: merged.deliveriesChosen === true,
    };
  }
  state.deps.store().write(next);
  state.settings = next;
  return getSettings(corporationID);
}

function isEnabled(corporationID) {
  const id = positive(corporationID);
  const settings = getSettings(id);
  if (settings.enabled !== null) return settings.enabled;
  return Boolean(resolveDepot(id));
}

function resolveDepot(corporationID) {
  const id = positive(corporationID);
  try {
    // Read-only view: listStructures() would deep-copy every structure.
    const structureState = load("services/structure/structureState");
    const structures = typeof structureState.peekStructures === "function"
      ? structureState.peekStructures()
      : structureState.listStructures();
    const { getCorporationHeadquartersStructure } = require("./playerBotStructurePriorityRuntime");
    const structure = getCorporationHeadquartersStructure(id, structures, state.deps.headquarters().getHeadquarters(id));
    if (structure) {
      return {
        kind: "structure",
        stationID: positive(structure.structureID || structure.itemID),
        systemID: positive(structure.solarSystemID),
        name: String(structure.itemName || structure.name || ""),
        hasQuantumCore: structure.hasQuantumCore === true,
      };
    }
  } catch (error) {
    // Keep the saved NPC/structure HQ fallback if structure metadata is unavailable.
  }
  const headquarters = state.deps.headquarters().getHeadquarters(id);
  return headquarters && !headquarters.error && positive(headquarters.stationID) ? headquarters : null;
}

// Run `action` so that jobs it starts for the corporation deposit even when the
// corporation has no saved HQ (used by /bots corp work). An explicit "off" wins.
function forceFor(corporationID, action) {
  const id = positive(corporationID);
  let explicitlyOff = false;
  try {
    explicitlyOff = getSettings(id).enabled === false;
  } catch (error) {
    // Unreadable settings must not stop the work order itself.
    warn(`Deposit settings could not be read for corporation ${id}: ${error.message}`);
    return action();
  }
  if (!id || explicitlyOff) return action();
  const already = state.forced.has(id);
  state.forced.add(id);
  try {
    return action();
  } finally {
    if (!already) state.forced.delete(id);
  }
}

// ------------------------------------------------------ operation wiring

function decorateOperation(operation, bot) {
  if (!operation || !DEPOSIT_KINDS.has(operation.kind)) return;
  const corporationID = positive(operation.corporationID || (bot && bot.corporationID));
  if (!corporationID) return;
  if (!state.forced.has(corporationID) && !isEnabled(corporationID)) return;
  const depot = resolveDepot(corporationID);
  if (!depot) return;
  operation.depositToCorporation = true;
  operation.depositStationID = depot.stationID;
  if (operation.kind === "mine") {
    operation.sell = false;
  } else {
    operation.marketStationID = depot.stationID;
    operation.homeStationID = depot.stationID;
    operation.optimizeMarketDestination = false;
    operation.depositOnly = true;
  }
}

function shouldDeposit(operation) {
  return Boolean(operation && DEPOSIT_KINDS.has(operation.kind) && operation.depositToCorporation === true &&
    operation.depositStarted !== true && positive(operation.depositStationID) &&
    positive(operation.corporationID));
}

function describeTarget(corporationID, depotStationID, prepared = null) {
  const settings = getSettings(corporationID);
  const deliveries = { locationID: positive(depotStationID), flagID: FLAG_CORP_DELIVERIES, label: "Corporation Deliveries" };
  // The office hangar the hangar runtime prepared (roles granted, office
  // rented, division by kind of work), unless a division was chosen by hand.
  if (settings.target === "hangar" && prepared && prepared.locationID) {
    const flagID = settings.explicitDivision ? FLAG_CORP_HANGAR_1 + settings.division - 1 : prepared.flagID;
    return {
      locationID: prepared.locationID, flagID,
      label: settings.explicitDivision ? `corporation hangar division ${settings.division}` : prepared.label,
      fallback: deliveries,
    };
  }
  if (settings.target === "hangar") {
    const offices = state.deps.corporations().getCorporationOffices(corporationID) || [];
    const office = offices.find((entry) => positive(entry && entry.stationID) === positive(depotStationID));
    const locationID = office && (positive(office.officeID) || positive(office.officeFolderID) || positive(office.itemID));
    if (locationID) {
      return {
        locationID, flagID: FLAG_CORP_HANGAR_1 + settings.division - 1,
        label: `corporation hangar division ${settings.division}`,
        fallback: { locationID: positive(depotStationID), flagID: FLAG_CORP_DELIVERIES, label: "Corporation Deliveries" },
      };
    }
  }
  return { locationID: positive(depotStationID), flagID: FLAG_CORP_DELIVERIES, label: "Corporation Deliveries", fallback: null };
}

function begin(operation, kit) {
  operation.depositStarted = true;
  operation.depositedUnits = 0;
  operation.depositFailedPasses = 0;
  operation.status = "active";
  operation.stage = STAGE;
  operation.lastError = null;
  delete operation.completedAt;
  const target = describeTarget(positive(operation.corporationID), operation.depositStationID);
  kit.record(operation, `Job finished; depositing the output in ${target.label} at headquarters ${operation.depositStationID}.`);
  kit.save(operation);
  return { delayMs: kit.STEP_DELAY_MS };
}

// -------------------------------------------------------------- stepping

function isDepositable(stack) {
  const type = state.deps.registry().resolveItemByTypeID(Number(stack && stack.typeID)) || {};
  return DEPOSIT_CATEGORIES.has(Number(type.categoryID));
}

function sourceStations(operation) {
  return [operation.homeStationID, operation.sourceStationID, operation.marketStationID, operation.originStationID]
    .map(positive)
    .filter((value, index, values) => value > 0 && values.indexOf(value) === index);
}

function transferStacks(operation, stacks, target, kit) {
  const itemStore = state.deps.itemStore();
  const corporationID = positive(operation.corporationID);
  let units = 0;
  let failure = "";
  for (const stack of stacks) {
    let destination = target;
    let result = null;
    for (let attempt = 0; attempt < 2 && destination; attempt += 1) {
      result = itemStore.transferItemToOwnerLocationIdempotent(
        Number(stack.itemID), corporationID, destination.locationID, destination.flagID, null,
        {
          receiptKey: `playerbot-corp-deposit:${operation.operationID}:${stack.itemID}`,
          fingerprint: {
            itemID: Number(stack.itemID), corporationID,
            locationID: destination.locationID, flagID: destination.flagID,
          },
        },
      );
      if (result && result.success) break;
      destination = attempt === 0 ? destination.fallback : null;
      if (destination) kit.record(operation, `Could not file ${stack.itemID} in ${target.label} (${result && result.errorMsg || "error"}); using ${destination.label}.`);
    }
    if (result && result.success) units += kit.inventory.unitsOf(stack);
    else failure = `${stack.itemID}: ${result && result.errorMsg || "UNKNOWN"}`;
  }
  return { units, failure };
}

async function advance(operation, bot, kit) {
  const inventory = kit.inventory;
  const depotID = positive(operation.depositStationID);
  const corporationID = positive(operation.corporationID);
  if (!depotID || !corporationID) return kit.finish(operation, "Deposit ended: no headquarters is recorded for this job.");
  const character = kit.getCharacterRecord(bot.characterID) || {};
  const dockedAt = positive(character.stationID || character.structureID);
  const goodsAt = (stationID) => inventory.listHangar(bot, stationID).filter(isDepositable);
  const carried = inventory.listCargo(bot).filter(isDepositable);

  if (dockedAt === depotID) {
    if (carried.length) inventory.unloadCargo(bot);
    let prepared = null;
    if (getSettings(corporationID).target === "hangar") {
      try {
        prepared = await state.deps.hangars().prepareDeposit(bot, corporationID, depotID, operation.kind);
      } catch (error) {
        warn(`Hangar preparation failed for corporation ${corporationID}: ${error.message}`);
      }
    }
    const target = describeTarget(corporationID, depotID, prepared);
    const stacks = goodsAt(depotID);
    if (stacks.length) {
      const moved = transferStacks(operation, stacks, target, kit);
      operation.depositedUnits = (Number(operation.depositedUnits) || 0) + moved.units;
      if (moved.units) kit.record(operation, `Deposited ${moved.units} unit(s) in ${target.label} at ${depotID}.`);
      if (moved.failure) {
        operation.depositFailedPasses = (Number(operation.depositFailedPasses) || 0) + 1;
        if (operation.depositFailedPasses >= MAX_FAILED_PASSES) {
          return kit.block(operation, "holding", `Could not hand all goods to the corporation (${moved.failure}); they remain in the pilot's hangar at ${depotID}.`);
        }
        return { delayMs: kit.STEP_DELAY_MS };
      }
    }
    const waiting = sourceStations(operation).filter((stationID) => stationID !== depotID && goodsAt(stationID).length);
    if (waiting.length) {
      operation.depositFailedPasses = 0;
      kit.save(operation);
      return { delayMs: kit.STEP_DELAY_MS };
    }
    return kit.finish(operation, `Deposit complete: ${Number(operation.depositedUnits) || 0} unit(s) are in ${target.label} at headquarters ${depotID}.`);
  }

  if (carried.length) {
    const step = await kit.travelToStation(operation, bot, depotID);
    return step || { delayMs: kit.STEP_DELAY_MS };
  }
  const source = [dockedAt, ...sourceStations(operation)].filter(Boolean)
    .find((stationID) => stationID !== depotID && goodsAt(stationID).length);
  if (!source) {
    return kit.finish(operation, `Deposit complete: ${Number(operation.depositedUnits) || 0} unit(s) deposited; nothing else to take to headquarters ${depotID}.`);
  }
  const step = await kit.travelToStation(operation, bot, source);
  if (step) return step;
  let loaded = 0;
  for (const stack of goodsAt(source)) {
    const result = inventory.loadToCargo(bot, stack.itemID);
    loaded += Number(result && result.moved) || 0;
    if (!result || !result.success) break;
  }
  if (!loaded) {
    operation.depositFailedPasses = (Number(operation.depositFailedPasses) || 0) + 1;
    if (operation.depositFailedPasses >= MAX_FAILED_PASSES) {
      return kit.block(operation, "holding", `Could not load the output at ${source} for the trip to headquarters ${depotID}; check cargo capacity.`);
    }
  } else {
    kit.record(operation, `Loaded ${loaded} unit(s) at ${source} for headquarters ${depotID}.`);
    kit.save(operation);
  }
  return { delayMs: kit.STEP_DELAY_MS };
}

function describeSettings(corporationID) {
  const settings = getSettings(corporationID);
  const depot = resolveDepot(corporationID);
  const enabled = isEnabled(corporationID);
  const explicit = settings.enabled !== null;
  return {
    enabled,
    explicit,
    target: settings.target,
    division: settings.division,
    depot,
    label: settings.target === "deliveries" ? "Corporation Deliveries"
      : settings.explicitDivision ? `corporation hangar division ${settings.division}`
        : "corporation hangars by kind of work (1 Mining, 2 Planetary)",
  };
}

module.exports = {
  configure,
  reset,
  getSettings,
  updateSettings,
  isEnabled,
  describeSettings,
  forceFor,
  decorateOperation,
  shouldDeposit,
  begin,
  advance,
  STAGE,
  _testing: { describeTarget, sourceStations, isDepositable, state },
};
