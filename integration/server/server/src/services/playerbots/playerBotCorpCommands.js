"use strict";

/*
 * /bots corp commands for playerbot corporations (also /playerbots corp ...).
 * Contributed by Luna.
 *
 *   /bots corp recall [corporationID] [station|structure <id>]
 *   /bots corp work   [corporationID] [auto|mine|pi|director] [trips <n>] [station|structure <id>]
 *   /bots corp status [corporationID]
 *   /bots corp hq     [corporationID] [list | set <structureOrStationID> | clear]
 *   /bots corp help
 *
 * The chat command router calls handle(); this module only uses exported
 * runtime functions the /playerbots chat commands already use.
 *
 * Destination ("HQ") resolution, first match wins:
 *   1. station|structure <id> on the command (this order only);
 *   2. the HQ saved with /bots corp hq set (an NPC station or a structure owned by
 *      the corporation with an online docking service);
 *   3. the corporation record's headquarters (always an NPC station).
 *
 * recall to an NPC station: running work is stopped, then the existing durable
 *   "relocate" operation undocks, routes, warps and docks the pilot. The pilot
 *   is paused once docked, so the director does not send it away again.
 * recall to a structure: the relocate operation only accepts NPC stations, so
 *   the pilot's work is stopped and the pilot is paused immediately, then this
 *   file steps it there itself with the same exported helpers the route and
 *   relocation code use (advanceSystemRoute between systems, travelToStation
 *   inside the destination system). Paused pilots skip their own threat
 *   responses, so structure recalls are best used in safe space. A pilot whose
 *   structure trip fails or times out is released again instead of being left
 *   paused in space.
 * work: clears the pause and starts mining (from the HQ when its system has
 *   safe belts, otherwise from the nearest safe belt system) and/or PI colony
 *   setup. Everything else is left to the normal director.
 *
 * Standing orders persist in the playerBots game-store table: a recall stays
 * in force (pilots held at the HQ) until a work order replaces it, and a work
 * order keeps its unstarted pilots. restoreStandingOrders() re-issues both
 * after a server restart. The dashboard uses runCorporationCommand(), which
 * takes structured arguments and acts as the server operator. Saved HQs
 * persist in the same table.
 */

const TICK_MS = 2000;
const BATCH_PER_TICK = 25;
const MAX_RETRIES = 8;
const ORDER_TTL_MS = 6 * 60 * 60 * 1000;
const STEP_DELAY_MS = 3000;
const RUNNING_STATUSES = new Set(["active", "holding", "review"]);
const MINING_MIN_SECURITY = 0.45;
const MODES = new Set(["auto", "mine", "pi", "director"]);
const COMBAT_SPECIALTIES = new Set(["security", "piracy", "sovereignty"]);
const LIST_LIMIT = 15;

function load(relativePath) {
  return require(`../../${relativePath}`);
}

const HQ_TABLE = "playerBots";
const HQ_PATH = "/_corpCommandHeadquarters";
const STANDING_ORDERS_PATH = "/_corpCommandStandingOrders";
const COMMAND_LOG_PATH = "/_corpCommandLog";
const COMMAND_LOG_LIMIT = 40;

function tableStore(pathName, errorCode, { flushSync = false } = {}) {
  let repo = null;
  const getRepo = () => {
    if (!repo) repo = load("gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
    return repo;
  };
  return {
    read() {
      const store = getRepo();
      store.ensureTable(HQ_TABLE);
      const result = store.read(HQ_TABLE, pathName);
      return result.success && result.data && typeof result.data === "object" ? { ...result.data } : {};
    },
    write(value) {
      const store = getRepo();
      store.ensureTable(HQ_TABLE);
      const result = store.write(HQ_TABLE, pathName, value);
      if (!result || !result.success) throw new Error(result && result.errorMsg || errorCode);
      // The playerBots table is large; only the rarely changed HQ setting
      // flushes synchronously. Orders and the log ride the normal flush.
      if (flushSync && typeof store.flushTableSync === "function") store.flushTableSync(HQ_TABLE);
    },
  };
}

function defaultHqStore() {
  return tableStore(HQ_PATH, "PLAYERBOT_CORP_HQ_WRITE_FAILED", { flushSync: true });
}

function defaultStandingOrderStore() {
  return tableStore(STANDING_ORDERS_PATH, "PLAYERBOT_CORP_ORDER_WRITE_FAILED");
}

function defaultCommandLogStore() {
  return tableStore(COMMAND_LOG_PATH, "PLAYERBOT_CORP_LOG_WRITE_FAILED");
}

function defaultDeps() {
  return {
    playerBots: () => load("services/playerbots/playerBotRuntime"),
    operations: () => load("services/playerbots/playerBotOperationRuntime"),
    tasks: () => load("services/playerbots/playerBotTaskRuntime"),
    space: () => load("services/playerbots/playerBotSpaceRuntime"),
    industryCycles: () => load("services/playerbots/playerBotIndustryCycleRuntime"),
    characters: () => load("services/character/characterState"),
    corporations: () => load("services/corporation/corporationState"),
    structures: () => load("services/structure/structureState"),
    deposit: () => load("services/playerbots/playerBotCorpDepositRuntime"),
    worldData: () => load("space/worldData"),
    replies: () => load("services/chat/commands/commandReplies"),
    hasStaffRole: (session) => load("services/chat/commands/commandAccess").hasStaffDebugRole(session),
    log: () => load("utils/logger"),
    hqStore: defaultHqStore,
    standingOrderStore: defaultStandingOrderStore,
    commandLogStore: defaultCommandLogStore,
    now: () => Date.now(),
  };
}

const state = {
  deps: defaultDeps(),
  orders: new Map(),
  jobs: new Map(),
  hq: null,
  standing: null,
  commandLog: null,
  timer: null,
};

function configure(overrides = {}) {
  state.deps = { ...defaultDeps(), ...overrides };
  state.hq = null;
  state.standing = null;
  state.commandLog = null;
}

function reset() {
  stopTimer();
  state.orders.clear();
  state.jobs.clear();
  state.hq = null;
  state.standing = null;
  state.commandLog = null;
  state.deps = defaultDeps();
}

// ------------------------------------------------------ standing orders

function standingOrders() {
  if (!state.standing) {
    try { state.standing = state.deps.standingOrderStore().read() || {}; }
    catch (error) { warn(`Could not read standing orders: ${error.message}`); state.standing = {}; }
  }
  return state.standing;
}

function saveStandingOrder(corporationID, record) {
  const next = { ...standingOrders() };
  if (record) next[String(corporationID)] = record;
  else delete next[String(corporationID)];
  state.standing = next;
  try { state.deps.standingOrderStore().write(next); }
  catch (error) { warn(`Could not save the standing order for corporation ${corporationID}: ${error.message}`); }
}

// A corporation's standing record is { recall?, work? }. A recall covers the
// whole corporation (characterIDs null, minus `released`) or listed pilots;
// a work order keeps the pilots it has not started yet.
function standingRecord(corporationID) {
  const raw = standingOrders()[String(positive(corporationID))];
  if (!raw || typeof raw !== "object") return {};
  if (raw.kind === "recall" || raw.kind === "work") return { [raw.kind]: raw };
  return { ...raw };
}

function updateStanding(corporationID, mutate) {
  const record = standingRecord(corporationID);
  mutate(record);
  for (const key of Object.keys(record)) if (!record[key]) delete record[key];
  saveStandingOrder(positive(corporationID), Object.keys(record).length ? record : null);
}

function idList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => positive(value)).filter(Boolean))];
}

// ---------------------------------------------------------- command log

function commandLog() {
  if (!state.commandLog) {
    try { state.commandLog = state.deps.commandLogStore().read() || {}; }
    catch (error) { warn(`Could not read the command log: ${error.message}`); state.commandLog = {}; }
  }
  return state.commandLog;
}

function appendCommandLog(corporationID, entry) {
  const key = String(positive(corporationID) || 0);
  const log = { ...commandLog() };
  const rows = Array.isArray(log[key]) ? log[key].slice(-(COMMAND_LOG_LIMIT - 1)) : [];
  rows.push({
    at: new Date(state.deps.now()).toISOString(),
    source: String(entry.source || "chat"),
    action: String(entry.action || ""),
    message: String(entry.message || "").slice(0, 400),
    success: entry.success !== false,
  });
  log[key] = rows;
  state.commandLog = log;
  try { state.deps.commandLogStore().write(log); }
  catch (error) { warn(`Could not save the command log: ${error.message}`); }
}

function getCommandLog(corporationID) {
  const rows = commandLog()[String(positive(corporationID))];
  return Array.isArray(rows) ? [...rows].reverse() : [];
}

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function warn(message) {
  try { state.deps.log().warn(`[CorpCommands] ${message}`); } catch (error) { /* logger unavailable */ }
}

function isPaused(bot) {
  return bot.status === "paused" || bot.autonomyPaused === true;
}

function hasOperation(operation) {
  return Boolean(operation && (
    RUNNING_STATUSES.has(operation.status) || operation.pending || operation.loadSheddingPaused === true
  ));
}

function botsOf(corporationID) {
  return state.deps.playerBots().listBots()
    .filter((bot) => positive(bot.corporationID) === corporationID);
}

function characterRecord(bot) {
  return state.deps.characters().getCharacterRecord(bot.characterID) || {};
}

function dockedStationOf(bot) {
  const record = characterRecord(bot);
  return positive(record.stationID || record.structureID);
}

// ------------------------------------------------------- HQ resolution

function savedHeadquarters() {
  if (!state.hq) state.hq = state.deps.hqStore().read() || {};
  return state.hq;
}

function validateStructure(structure, corporationID) {
  if (structure.destroyedAt || structure.unanchoring) return "is destroyed or unanchoring";
  if (positive(structure.ownerCorpID) !== corporationID) return `is not owned by corporation ${corporationID}`;
  if (!state.deps.structures().isDockingServiceOnline(structure)) return "has no online docking service";
  return "";
}

function describeDestination(destinationID, corporationID) {
  const worldData = state.deps.worldData();
  const station = worldData.getStationByID(destinationID);
  if (station) {
    return { kind: "station", stationID: destinationID, systemID: positive(station.solarSystemID), name: String(station.stationName || station.itemName || "") };
  }
  const structure = state.deps.structures().getStructureByID(destinationID, { refresh: false });
  if (!structure) {
    return { error: `${destinationID} is not an NPC station or a known structure.` };
  }
  const problem = validateStructure(structure, corporationID);
  if (problem) return { error: `Structure ${destinationID} ${problem}.` };
  return {
    kind: "structure",
    stationID: destinationID,
    systemID: positive(structure.solarSystemID),
    name: String(structure.itemName || structure.name || ""),
    hasQuantumCore: structure.hasQuantumCore === true,
  };
}

function resolveHeadquarters(corporationID, overrideID) {
  const explicit = positive(overrideID);
  if (explicit) return describeDestination(explicit, corporationID);
  const saved = positive(savedHeadquarters()[String(corporationID)]);
  if (saved) {
    const described = describeDestination(saved, corporationID);
    return described.error
      ? { error: `The saved HQ is unusable: ${described.error} Run "/bots corp hq ${corporationID} clear" or choose another with "/bots corp hq ${corporationID} set <id>".` }
      : { ...described, saved: true };
  }
  const record = state.deps.corporations().getCorporationRecord(corporationID);
  const stationID = positive(record && record.stationID);
  if (!stationID) {
    return { error: `Corporation ${corporationID} has no headquarters set. Set one in the corporation window, or use "/bots corp hq ${corporationID} set <structureOrStationID>".` };
  }
  return describeDestination(stationID, corporationID);
}

function formatDestination(destination) {
  if (destination.name) return `${destination.name} (${destination.kind} ${destination.stationID})`;
  return `${destination.kind === "structure" ? "structure" : "station"} ${destination.stationID}`;
}

function canControlCorporation(session, corporationID) {
  if (state.deps.hasStaffRole(session)) return true;
  const own = positive(session && (session.corporationID || session.corpid));
  return own > 0 && own === corporationID;
}

function canManageHeadquarters(session, corporationID) {
  if (state.deps.hasStaffRole(session)) return true;
  const record = state.deps.corporations().getCorporationRecord(corporationID);
  const characterID = positive(session && (session.characterID || session.charID || session.charid));
  return characterID > 0 && characterID === positive(record && record.ceoID);
}

// ----------------------------------------------------------------- recall

function advanceRecallStation(bot, headquarters) {
  const operations = state.deps.operations();
  const tasks = state.deps.tasks();
  const operation = operations.getOperation(bot.characterID);
  const running = hasOperation(operation);
  const toHeadquarters = running && operation.kind === "relocate" &&
    positive(operation.destinationStationID) === headquarters.stationID;
  const paused = isPaused(bot);

  if (dockedStationOf(bot) === headquarters.stationID) {
    // The relocation finishes on its next step; a paused pilot cannot take it.
    if (toHeadquarters) {
      if (paused) tasks.resumeBot(bot);
      return { state: "enRoute" };
    }
    if (running) {
      operations.stopOperation(bot.characterName);
      return { state: "retry", message: "stopping current work" };
    }
    if (!paused) {
      const held = tasks.pauseBot(bot);
      if (!held.success) return { state: "retry", message: held.message || "pause failed" };
    }
    return { state: "held" };
  }

  if (toHeadquarters) {
    if (paused) tasks.resumeBot(bot);
    return { state: "enRoute" };
  }
  if (running) {
    const stopped = operations.stopOperation(bot.characterName);
    if (stopped && stopped.success === false) return { state: "retry", message: stopped.message };
  }
  if (paused) tasks.resumeBot(bot);
  const started = operations.startRelocation(bot.characterName, headquarters.stationID);
  return started.success
    ? { state: "enRoute" }
    : { state: "retry", message: started.message };
}

const TRAVEL_STORE = Object.freeze({
  save() {},
  block(operation, status, reason) {
    return { blocked: true, message: String(reason) };
  },
});

function checkStructureAccess(bot, headquarters) {
  const structures = state.deps.structures();
  const structure = structures.getStructureByID(headquarters.stationID, { refresh: false });
  if (!structure) return "the structure no longer exists";
  const problem = validateStructure(structure, positive(bot.corporationID));
  if (problem) return `the structure ${problem}`;
  const session = state.deps.space().getActorSession(bot);
  const docking = structures.canCharacterDockAtStructure(session, structure, {
    shipTypeID: positive(session && session.shipTypeID) || undefined,
  });
  return docking && docking.success ? "" : `docking is refused (${docking && docking.errorMsg || "no permission"})`;
}

function advanceRecallStructure(bot, headquarters, entry, order = null) {
  const operations = state.deps.operations();
  const tasks = state.deps.tasks();
  const now = state.deps.now();

  if (hasOperation(operations.getOperation(bot.characterID))) {
    operations.stopOperation(bot.characterName);
    return { state: "retry", message: "stopping current work" };
  }
  const cycle = state.deps.industryCycles().getCycle(bot.characterID);
  if (cycle && (["active", "holding"].includes(cycle.status) || cycle.pending)) {
    return { state: "retry", message: `is in industry cycle ${cycle.cycleID}; stop it first` };
  }
  if (dockedStationOf(bot) === headquarters.stationID) {
    if (!isPaused(bot)) {
      const held = tasks.pauseBot(bot);
      if (!held.success) return { state: "retry", message: held.message || "pause failed" };
    }
    return { state: "held" };
  }
  if (!entry.accessChecked) {
    const refusal = checkStructureAccess(bot, headquarters);
    if (refusal) return { state: "failed", message: refusal };
    entry.accessChecked = true;
  }
  // Paused pilots are ignored by the director; the steps below do not need
  // route tasks, which are not run for paused pilots.
  if (!isPaused(bot)) {
    const held = tasks.pauseBot(bot);
    if (!held.success) return { state: "retry", message: held.message || "pause failed" };
  }
  if (entry.stepError) {
    const message = entry.stepError;
    entry.stepError = "";
    return { state: "retry", message };
  }
  if (entry.inFlight || Number(entry.nextAtMs) > now) return { state: "enRoute" };
  entry.nextAtMs = now + STEP_DELAY_MS;

  const systemID = positive(characterRecord(bot).solarSystemID);
  if (systemID !== headquarters.systemID) {
    const step = state.deps.space().advanceSystemRoute(bot, headquarters.systemID);
    if (!step || step.success !== true) {
      return { state: "retry", message: step && step.message || "route step failed" };
    }
    entry.nextAtMs = now + (Number(step.delayMs) > 0 ? Number(step.delayMs) : STEP_DELAY_MS);
    return { state: "enRoute" };
  }
  entry.inFlight = true;
  entry.travel = entry.travel || { kind: "corp-recall", stage: "travel", history: [] };
  Promise.resolve()
    .then(() => operations.travelToStation(entry.travel, bot, headquarters.stationID, TRAVEL_STORE))
    .then((step) => {
      if (order && order.cancelled) return;
      if (step && step.blocked) entry.stepError = step.message;
      else if (step && Number(step.delayMs) > 0) entry.nextAtMs = state.deps.now() + Number(step.delayMs);
    })
    .catch((error) => { entry.stepError = error && error.message || String(error); })
    .then(() => { entry.inFlight = false; });
  return { state: "enRoute" };
}

function advanceRecall(bot, headquarters, entry = {}, order = null) {
  return headquarters.kind === "structure"
    ? advanceRecallStructure(bot, headquarters, entry, order)
    : advanceRecallStation(bot, headquarters);
}

// Drops a corporation's earlier recall and work orders. A structure trip step
// already in flight finishes, but its result is ignored.
function cancelOrders(corporationID) {
  const order = state.orders.get(corporationID);
  if (order) order.cancelled = true;
  state.orders.delete(corporationID);
  state.jobs.delete(corporationID);
}

function createRecallOrder(corporationID, headquarters, bots, context) {
  const pending = new Map();
  for (const bot of bots) pending.set(Number(bot.characterID), { attempts: 0, message: "" });
  const order = {
    corporationID,
    headquarters,
    createdAt: state.deps.now(),
    pending,
    total: bots.length,
    held: 0,
    failed: 0,
    gone: 0,
    failures: [],
    context,
  };
  state.orders.set(corporationID, order);
  return order;
}

function summarizeFailures(failures) {
  const counts = new Map();
  for (const entry of failures) {
    const reason = String(entry.message || "unknown").replace(/^.*? already has operation/, "already has operation").slice(0, 90);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].slice(0, 3).map(([reason, count]) => `${count} x ${reason}`).join("; ");
}

function notify(context, message, corporationID = 0, action = "") {
  if (corporationID) appendCommandLog(corporationID, { source: context && context.source || "chat", action, message });
  if (!context || !context.chatHub) return;
  try {
    state.deps.replies().emitChatFeedback(context.chatHub, context.session, context.options, message);
  } catch (error) {
    warn(`Could not deliver progress message: ${error.message}`);
  }
}

// A structure trip pauses the pilot in space. If the trip does not finish,
// hand the pilot back to the director rather than leave it paused there.
function releaseStrandedPilot(order, characterID) {
  if (order.headquarters.kind !== "structure") return;
  const bot = botsOf(order.corporationID).find((entry) => Number(entry.characterID) === Number(characterID));
  if (!bot || !isPaused(bot) || dockedStationOf(bot) === order.headquarters.stationID) return;
  try {
    state.deps.tasks().resumeBot(bot);
  } catch (error) {
    warn(`Could not release ${bot.characterName} after a failed structure recall: ${error.message}`);
  }
}

function finishOrder(order, reason) {
  state.orders.delete(order.corporationID);
  if (reason === "expired") {
    for (const characterID of order.pending.keys()) releaseStrandedPilot(order, characterID);
  }
  const detail = order.failed ? ` ${order.failed} could not be recalled (${summarizeFailures(order.failures)}).` : "";
  updateStanding(order.corporationID, (record) => {
    if (record.recall) {
      record.recall = { ...record.recall, status: reason === "expired" ? "expired" : "holding", finishedAt: new Date(state.deps.now()).toISOString(), held: order.held, failed: order.failed };
    }
  });
  notify(order.context, reason === "expired"
    ? `Recall for corporation ${order.corporationID} timed out with ${order.pending.size} pilot(s) unfinished. Run /bots corp status ${order.corporationID}.`
    : `Recall complete for corporation ${order.corporationID}: ${order.held} of ${order.total} pilot(s) docked and held at ${formatDestination(order.headquarters)}.${detail}`,
  order.corporationID, "recall");
}

function runRecallBatch(order, budget) {
  const roster = new Map(botsOf(order.corporationID).map((bot) => [Number(bot.characterID), bot]));
  const slice = [...order.pending.entries()].slice(0, budget);
  for (const [characterID, entry] of slice) {
    const bot = roster.get(characterID);
    if (!bot) {
      order.pending.delete(characterID);
      order.gone += 1;
      continue;
    }
    let result;
    try {
      result = advanceRecall(bot, order.headquarters, entry, order);
    } catch (error) {
      result = { state: "retry", message: error.message };
    }
    order.pending.delete(characterID);
    if (result.state === "held") {
      order.held += 1;
    } else if (result.state === "failed") {
      order.failed += 1;
      order.failures.push({ name: bot.characterName, message: result.message });
      releaseStrandedPilot(order, characterID);
    } else if (result.state === "retry") {
      entry.attempts += 1;
      entry.message = result.message || "";
      if (entry.attempts >= MAX_RETRIES) {
        order.failed += 1;
        order.failures.push({ name: bot.characterName, message: entry.message });
        releaseStrandedPilot(order, characterID);
      } else {
        order.pending.set(characterID, entry);
      }
    } else {
      entry.attempts = 0;
      order.pending.set(characterID, entry);
    }
  }
  return slice.length;
}

// ------------------------------------------------------------------- work

function hqSupportsMining(headquarters) {
  if (!headquarters || headquarters.error) return false;
  if (headquarters.kind === "structure" && headquarters.hasQuantumCore !== true) return false;
  const worldData = state.deps.worldData();
  const system = worldData.getSolarSystemByID(headquarters.systemID) || {};
  return Number(system.security) >= MINING_MIN_SECURITY &&
    (worldData.getAsteroidBeltsForSystem(headquarters.systemID) || []).length > 0;
}

function planFor(bot, mode) {
  if (mode !== "auto") return mode;
  const specialty = String(bot.specialty || "").toLowerCase();
  if (specialty === "planetary") return "pi";
  if (COMBAT_SPECIALTIES.has(specialty)) return "director";
  return "mine";
}

function startMiningFor(bot, job) {
  const operations = state.deps.operations();
  const base = { refine: true, sell: true };
  if (hqSupportsMining(job.headquarters)) {
    const homed = operations.startMining(bot.characterName, job.trips, {
      ...base, stationID: job.headquarters.stationID,
    });
    if (homed && homed.success) return homed;
  }
  // The HQ cannot be a mining home (no belts, low security, no quantum core or
  // no docking right): mine from the nearest safe belt system instead.
  return operations.startMining(bot.characterName, job.trips, base);
}

function startWorkForBot(bot, job) {
  const operations = state.deps.operations();
  if (hasOperation(operations.getOperation(bot.characterID))) return { status: "already" };
  const plan = planFor(bot, job.mode);
  if (plan === "director") return { status: "director" };
  const start = () => (plan === "pi"
    ? operations.startColony(bot.characterName)
    : startMiningFor(bot, job));
  // Work ordered with /bots corp work takes its output to the HQ unless the
  // corporation turned deposit off.
  let deposit = null;
  try { deposit = state.deps.deposit(); } catch (error) { warn(`Corporation deposit is unavailable: ${error.message}`); }
  const result = deposit && typeof deposit.forceFor === "function"
    ? deposit.forceFor(job.corporationID, start)
    : start();
  return result && result.success
    ? { status: "started", plan }
    : { status: "failed", message: result && result.message || "start refused" };
}

const WORK_PERSIST_MS = 15_000;

function persistWork(job, force = false) {
  const now = state.deps.now();
  if (!force && now - (job.persistedAt || 0) < WORK_PERSIST_MS) return;
  job.persistedAt = now;
  const overrides = {};
  for (const [characterID, override] of job.overrides || []) {
    if (job.pending.includes(characterID)) overrides[characterID] = { mode: override.mode, trips: override.trips, destinationID: override.destinationID };
  }
  updateStanding(job.corporationID, (record) => {
    record.work = job.pending.length ? {
      mode: job.mode,
      trips: job.trips,
      destinationID: positive(job.destinationID),
      pending: [...job.pending],
      overrides,
      createdAt: job.createdAt || new Date(now).toISOString(),
      source: job.context && job.context.source || "chat",
    } : null;
  });
}

function runWorkBatch(job, budget) {
  const roster = new Map(botsOf(job.corporationID).map((bot) => [Number(bot.characterID), bot]));
  const slice = job.pending.splice(0, budget);
  for (const characterID of slice) {
    const bot = roster.get(characterID);
    if (!bot) continue;
    const override = job.overrides && job.overrides.get(characterID);
    let result;
    try {
      result = startWorkForBot(bot, override ? { ...job, ...override } : job);
    } catch (error) {
      result = { status: "failed", message: error.message };
    }
    if (result.status === "failed") {
      job.failures.push({ name: bot.characterName, message: result.message });
    } else {
      const key = result.status === "started" ? result.plan : result.status;
      job.counts[key] = (job.counts[key] || 0) + 1;
    }
  }
  if (slice.length && job.pending.length) persistWork(job);
  return slice.length;
}

function finishJob(job) {
  state.jobs.delete(job.corporationID);
  updateStanding(job.corporationID, (record) => { record.work = null; });
  const parts = [];
  if (job.counts.mine) parts.push(`${job.counts.mine} mining`);
  if (job.counts.pi) parts.push(`${job.counts.pi} PI setup`);
  if (job.counts.already) parts.push(`${job.counts.already} already working`);
  if (job.counts.director) parts.push(`${job.counts.director} left to the director`);
  if (job.failures.length) parts.push(`${job.failures.length} refused (${summarizeFailures(job.failures)})`);
  notify(job.context, `Work order for corporation ${job.corporationID} (${job.mode}): ${parts.join(", ") || "no pilots"}.`,
    job.corporationID, "work");
}

// ----------------------------------------------------------------- ticker

function tick() {
  try {
    const now = state.deps.now();
    let budget = BATCH_PER_TICK;
    for (const order of [...state.orders.values()]) {
      if (now - order.createdAt > ORDER_TTL_MS) {
        finishOrder(order, "expired");
        continue;
      }
      if (budget > 0) budget -= runRecallBatch(order, budget);
      if (!order.pending.size) finishOrder(order, "done");
    }
    for (const job of [...state.jobs.values()]) {
      if (budget > 0) budget -= runWorkBatch(job, budget);
      if (!job.pending.length) finishJob(job);
    }
  } catch (error) {
    warn(`Tick failed: ${error.stack || error.message}`);
  }
  if (!state.orders.size && !state.jobs.size) stopTimer();
}

function ensureTimer() {
  if (state.timer) return;
  state.timer = setInterval(tick, TICK_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ---------------------------------------------------------------- commands

const HELP = [
  "/bots corp recall [corporationID] [station|structure <id>] - send every pilot to the corporation HQ, dock and hold them there",
  "/bots corp work [corporationID] [auto|mine|pi|director] [trips <n>] [station|structure <id>] - release the hold and start mining and PI around the HQ",
  "/bots corp status [corporationID] - show where the corporation's pilots are",
  "/bots corp hq [corporationID] [list | set <structureOrStationID> | clear] - show, list or change the HQ the commands above use (set/clear: CEO or staff)",
  "/bots corp deposit [corporationID] [status | on | off | auto | deliveries | hangar <1-7>] - deliver completed mining and PI output to the corporation HQ instead of selling it",
  "Omit the corporation ID to use your own corporation. Staff/admin may use any corporation.",
].join("\n");

function parseArguments(argumentText) {
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean)
    .map((token) => token.replace(/^[{<[(]+|[}>\])]+$/g, ""));
  const subcommand = (tokens.shift() || "help").toLowerCase();
  const parsed = {
    subcommand, corporationID: 0, station: 0, mode: "auto", trips: 1,
    hqAction: "", hqTarget: 0, depositAction: "", depositDivision: 0, error: "",
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    if (token === "station" || token === "structure") parsed.station = positive(tokens[index += 1]);
    else if (token === "trips") parsed.trips = Math.min(20, positive(tokens[index += 1]) || 1);
    else if (token === "set") { parsed.hqAction = "set"; parsed.hqTarget = positive(tokens[index += 1]); }
    else if (token === "clear" || token === "list") parsed.hqAction = token;
    else if (subcommand === "deposit" && ["on", "off", "auto", "deliveries", "status"].includes(token)) parsed.depositAction = token;
    else if (subcommand === "deposit" && token === "hangar") { parsed.depositAction = "hangar"; parsed.depositDivision = positive(tokens[index += 1]); }
    else if (MODES.has(token)) parsed.mode = token;
    else if (/^\d+$/.test(token) && !parsed.corporationID) parsed.corporationID = positive(token);
    else parsed.error = `Unrecognized argument: ${tokens[index]}.`;
  }
  return parsed;
}

// Takes pilots out of a running recall, e.g. when they are sent to work.
function removeFromRecall(corporationID, characterIDs) {
  const order = state.orders.get(corporationID);
  if (!order) return;
  for (const characterID of characterIDs) {
    if (order.pending.delete(characterID)) order.total = Math.max(0, order.total - 1);
  }
}

function removeFromJob(corporationID, characterIDs) {
  const job = state.jobs.get(corporationID);
  if (!job) return;
  const ids = new Set(characterIDs);
  job.pending = job.pending.filter((characterID) => !ids.has(characterID));
  for (const characterID of ids) job.overrides && job.overrides.delete(characterID);
}

function commandRecall(parsed, corporationID, bots, context) {
  const headquarters = resolveHeadquarters(corporationID, parsed.station);
  if (headquarters.error) return headquarters.error;
  const ids = bots.map((bot) => Number(bot.characterID));
  const idSet = new Set(ids);
  const now = new Date(state.deps.now()).toISOString();
  const source = context && context.source || "chat";
  if (bots.selection) {
    // Recall listed pilots without disturbing the rest of the corporation.
    const running = state.orders.get(corporationID);
    if (running && running.headquarters.stationID !== headquarters.stationID) {
      return `Could not recall: a recall to ${formatDestination(running.headquarters)} is already running for corporation ${corporationID}. Wait for it or cancel it first.`;
    }
    removeFromJob(corporationID, ids);
    if (running) {
      for (const characterID of ids) {
        if (!running.pending.has(characterID)) {
          running.pending.set(characterID, { attempts: 0, message: "" });
          running.total += 1;
        }
      }
    } else {
      createRecallOrder(corporationID, headquarters, bots, context);
    }
  } else {
    cancelOrders(corporationID);
    createRecallOrder(corporationID, headquarters, bots, context);
  }
  if (!parsed.restoring) {
    updateStanding(corporationID, (record) => {
      if (!bots.selection) {
        record.work = null;
        record.recall = { status: "recalling", destinationID: positive(parsed.station), characterIDs: null, released: [], createdAt: now, source };
        return;
      }
      if (record.work) {
        const pending = idList(record.work.pending).filter((characterID) => !idSet.has(characterID));
        record.work = pending.length ? { ...record.work, pending } : null;
      }
      const recall = record.recall;
      if (recall && !Array.isArray(recall.characterIDs)) {
        record.recall = { ...recall, status: "recalling", released: idList(recall.released).filter((characterID) => !idSet.has(characterID)) };
      } else {
        record.recall = {
          status: "recalling",
          destinationID: positive(parsed.station) || positive(recall && recall.destinationID),
          characterIDs: idList([...(recall ? recall.characterIDs : []), ...ids]),
          released: [],
          createdAt: recall && recall.createdAt || now,
          source,
        };
      }
    });
  }
  ensureTimer();
  const caution = headquarters.kind === "structure"
    ? " Pilots are paused for the trip and travel without their usual threat responses."
    : "";
  return `Recall ordered for ${bots.length} pilot(s) of corporation ${corporationID} to ${formatDestination(headquarters)} (system ${headquarters.systemID}). ` +
    `Pilots stop their current work, travel and dock, then are held.${caution} Progress: /bots corp status ${corporationID}. Release them with /bots corp work ${corporationID}.`;
}

// Lifts the standing recall from listed pilots (or the whole corporation).
function releaseFromStandingRecall(corporationID, characterIDs = null) {
  updateStanding(corporationID, (record) => {
    const recall = record.recall;
    if (!recall) return;
    if (!characterIDs) { record.recall = null; return; }
    const ids = new Set(characterIDs);
    if (!Array.isArray(recall.characterIDs)) {
      record.recall = { ...recall, released: idList([...(recall.released || []), ...characterIDs]) };
    } else {
      const left = idList(recall.characterIDs).filter((characterID) => !ids.has(characterID));
      record.recall = left.length ? { ...recall, characterIDs: left } : null;
    }
  });
}

// Pilots resumed by hand leave any recall they were part of, so a restart does
// not pull them back to the HQ.
function releasePilots(corporationID, characterIDs) {
  const id = positive(corporationID);
  const ids = idList(characterIDs);
  if (!id || !ids.length) return;
  removeFromRecall(id, ids);
  releaseFromStandingRecall(id, ids);
}

function resumePilots(corporationID, bots) {
  if (!bots.selection) return state.deps.tasks().resumeBotsInCorporation(corporationID);
  let affected = 0;
  const errors = [];
  for (const bot of bots) {
    try {
      const result = state.deps.tasks().resumeBot(bot);
      if (result && result.success) affected += 1;
      else errors.push(`${bot.characterName}:${result && result.message || "resume failed"}`);
    } catch (error) {
      errors.push(`${bot.characterName}:${error.message}`);
    }
  }
  return { success: errors.length === 0, affected, errors };
}

function commandWork(parsed, corporationID, bots, context) {
  const ids = bots.map((bot) => Number(bot.characterID));
  // A later "work director" must not leave an earlier "work mine" queued. A
  // selection only takes its own pilots out of running orders.
  if (bots.selection) {
    removeFromRecall(corporationID, ids);
    removeFromJob(corporationID, ids);
  } else {
    cancelOrders(corporationID);
  }
  const resumed = parsed.restoring ? { success: true, affected: 0 } : resumePilots(corporationID, bots);
  if (!resumed.success) {
    return `Could not release the corporation: ${(resumed.errors || []).join("; ") || resumed.message || "error"}.`;
  }
  if (!parsed.restoring) {
    releaseFromStandingRecall(corporationID, bots.selection ? ids : null);
    if (!bots.selection) updateStanding(corporationID, (record) => { record.work = null; });
  }
  if (parsed.mode === "director") {
    if (bots.selection) {
      const job = state.jobs.get(corporationID);
      if (job) persistWork(job, true);
    }
    return `Released ${resumed.affected} pilot(s); the director will assign work on its next pass.`;
  }
  const resolved = resolveHeadquarters(corporationID, parsed.station);
  const headquarters = resolved.error ? null : resolved;
  let job = state.jobs.get(corporationID);
  if (job) {
    // Pilots joining a running work order keep their own mode, trips and HQ.
    const override = { mode: parsed.mode, trips: parsed.trips, headquarters, destinationID: positive(parsed.station) };
    for (const characterID of ids) {
      if (!job.pending.includes(characterID)) job.pending.push(characterID);
      job.overrides.set(characterID, override);
    }
  } else {
    job = {
      corporationID,
      mode: parsed.mode,
      trips: parsed.trips,
      headquarters,
      destinationID: positive(parsed.station),
      pending: ids,
      overrides: new Map(),
      counts: {},
      failures: [],
      context,
      createdAt: new Date(state.deps.now()).toISOString(),
    };
    for (const [characterID, override] of Object.entries(parsed.overrides || {})) {
      job.overrides.set(Number(characterID), override);
    }
    state.jobs.set(corporationID, job);
  }
  persistWork(job, true);
  ensureTimer();
  return `Released ${resumed.affected} pilot(s) of corporation ${corporationID}. Starting ${parsed.mode} work` +
    `${headquarters ? ` around ${formatDestination(headquarters)}` : ""}; a summary follows.`;
}

function commandStatus(corporationID, bots) {
  const operations = state.deps.operations();
  const headquarters = resolveHeadquarters(corporationID, 0);
  const counts = { atHq: 0, held: 0, heldAway: 0, travelling: 0, working: 0, idle: 0 };
  const kinds = new Map();
  for (const bot of bots) {
    const operation = operations.getOperation(bot.characterID);
    const running = hasOperation(operation);
    const atHq = !headquarters.error && dockedStationOf(bot) === headquarters.stationID;
    if (atHq) counts.atHq += 1;
    if (isPaused(bot)) counts.held += 1;
    if (isPaused(bot) && !atHq && !(running && operation.kind === "relocate")) counts.heldAway += 1;
    if (running && operation.kind === "relocate") counts.travelling += 1;
    else if (running) {
      counts.working += 1;
      kinds.set(operation.kind, (kinds.get(operation.kind) || 0) + 1);
    } else if (!isPaused(bot)) counts.idle += 1;
  }
  const order = state.orders.get(corporationID);
  if (order) {
    // Structure trips have no operation record: count pilots still pending.
    counts.travelling = Math.max(counts.travelling,
      [...order.pending.keys()].filter((id) => {
        const bot = bots.find((entry) => Number(entry.characterID) === id);
        return bot && dockedStationOf(bot) !== order.headquarters.stationID;
      }).length);
  }
  const work = [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(", ");
  return [
    `Corporation ${corporationID}: ${bots.length} pilot(s); HQ ${headquarters.error ? "unavailable" : formatDestination(headquarters)}.`,
    `Docked at HQ ${counts.atHq}; held (paused) ${counts.held}; travelling ${counts.travelling}; working ${counts.working}${work ? ` (${work})` : ""}; idle ${counts.idle}.`,
    order ? `Recall in progress: ${order.pending.size} pilot(s) still pending, ${order.held} held, ${order.failed} failed.` : "No recall in progress.",
    ...(counts.heldAway && !order
      ? [`${counts.heldAway} held pilot(s) are not at the HQ (for example after a server restart); run /bots corp recall ${corporationID} or /bots corp work ${corporationID}.`]
      : []),
  ].join("\n");
}

function commandDeposit(parsed, session, corporationID, options = {}) {
  const deposit = state.deps.deposit();
  const action = parsed.depositAction;
  if (action && action !== "status") {
    if (!options.operator && !canManageHeadquarters(session, corporationID)) {
      return "Only the corporation's CEO or staff/admin can change the deposit settings.";
    }
    if (action === "hangar" && !(parsed.depositDivision >= 1 && parsed.depositDivision <= 7)) {
      return "Usage: /bots corp deposit [corporationID] hangar <division 1-7>.";
    }
    const patch = {
      on: { enabled: true },
      off: { enabled: false },
      auto: { enabled: null },
      deliveries: { target: "deliveries", deliveriesChosen: true },
      hangar: { target: "hangar", division: parsed.depositDivision, deliveriesChosen: false },
    }[action];
    try { deposit.updateSettings(corporationID, patch); }
    catch (error) { return `Could not save the deposit setting: ${error.message}.`; }
  }
  const info = deposit.describeSettings(corporationID);
  const mode = info.explicit
    ? (info.enabled ? "ON (set explicitly)" : "OFF (set explicitly)")
    : (info.enabled ? "ON (automatic: an HQ is saved with /bots corp hq set)" : "OFF (automatic: no HQ saved; /bots corp work still deposits)");
  return [
    `Deposit for corporation ${corporationID}: ${mode}.`,
    `Goods go to ${info.label}${info.depot ? ` at ${formatDestination(info.depot)}` : " (no usable HQ right now; see /bots corp hq)"}.`,
    "Mining and PI collection jobs started from now on take their output to the HQ and hand it to the corporation instead of selling it; ore and minerals go to hangar 1 (Mining), PI goods to hangar 2 (Planetary), unless a division is chosen. A bot-run corporation's CEO rents the office at the HQ; without an office the goods fall back to Corporation Deliveries, which EveJS does not show.",
  ].join("\n");
}

function commandHeadquarters(parsed, session, corporationID, options = {}) {
  const action = parsed.hqAction;
  if (action === "list") {
    const rows = state.deps.structures().listOwnedStructures(corporationID, { refresh: false })
      .filter((structure) => !structure.destroyedAt && !structure.unanchoring)
      .slice(0, LIST_LIMIT)
      .map((structure) => {
        const usable = !validateStructure(structure, corporationID);
        return `${structure.structureID || structure.itemID} - ${structure.itemName || structure.name || "unnamed"} - system ${structure.solarSystemID} - ${usable ? "docking online" : "docking unavailable"}`;
      });
    return rows.length
      ? `Structures owned by corporation ${corporationID}:\n${rows.join("\n")}\nChoose one with /bots corp hq ${corporationID} set <id>.`
      : `Corporation ${corporationID} owns no active structures.`;
  }
  if (action === "set" || action === "clear") {
    if (!options.operator && !canManageHeadquarters(session, corporationID)) {
      return "Only the corporation's CEO or staff/admin can change the HQ used by /bots corp.";
    }
    const store = state.deps.hqStore();
    const saved = { ...savedHeadquarters() };
    if (action === "clear") {
      delete saved[String(corporationID)];
    } else {
      if (!parsed.hqTarget) return "Usage: /bots corp hq [corporationID] set <structureOrStationID>.";
      const described = describeDestination(parsed.hqTarget, corporationID);
      if (described.error) return described.error;
      saved[String(corporationID)] = parsed.hqTarget;
    }
    try {
      store.write(saved);
    } catch (error) {
      return `Could not save the HQ setting: ${error.message}.`;
    }
    state.hq = saved;
    if (action === "clear") return `Saved HQ cleared for corporation ${corporationID}; /bots corp now uses the corporation's own headquarters.`;
    return `HQ for corporation ${corporationID} set to ${formatDestination(describeDestination(parsed.hqTarget, corporationID))}. It is used by /bots corp recall, work and status.`;
  }
  const record = state.deps.corporations().getCorporationRecord(corporationID);
  const own = positive(record && record.stationID);
  const effective = resolveHeadquarters(corporationID, 0);
  const savedID = positive(savedHeadquarters()[String(corporationID)]);
  return [
    `Corporation ${corporationID} headquarters: ${own ? `NPC station ${own}` : "none set in the corporation window"}.`,
    `Saved /bots corp HQ: ${savedID || "none"}.`,
    `In use: ${effective.error ? effective.error : formatDestination(effective)}.`,
  ].join("\n");
}

// Appended (never substituted) to the existing /bots help text by the preload.
const BOTS_HELP_ADDENDUM = [
  "Corporation commands: /bots corp <recall|work|status|hq|deposit|help> ... (also /playerbots corp ...)",
  "/bots corp recall [corporationID] [station|structure <id>] - stop every pilot's work, send them to the corporation HQ, dock and hold (pause) them there",
  "/bots corp work [corporationID] [auto|mine|pi|director] [trips <n>] [station|structure <id>] - release the hold, then start work. auto: planetary pilots set up PI, security/piracy/sovereignty pilots go back to the director, everyone else mines",
  "/bots corp status [corporationID] - pilots docked at the HQ, held, travelling, working (by operation) and idle, plus recall progress",
  "/bots corp hq [corporationID] - show the corporation's NPC HQ, the saved /bots corp HQ and the one in use",
  "/bots corp hq [corporationID] list - list the corporation's structures with ID, system and whether docking is online",
  "/bots corp hq [corporationID] set <structureOrStationID> - save the HQ that recall, work and status use (CEO or staff only; a structure must be corporation-owned with docking online)",
  "/bots corp hq [corporationID] clear - go back to the corporation's own NPC station HQ (CEO or staff only)",
  "/bots corp deposit [corporationID] [status | on | off | auto | deliveries | hangar <1-7>] - deposit mining and PI output at the corporation HQ instead of selling; CEO or staff changes settings",
  "Omit corporationID to use your own corporation. Staff/admin may use any corporation. Braces are accepted, e.g. /bots corp recall {98000123}.",
  "HQ choice, first match wins: station|structure <id> on the command (that order only); the HQ saved with /bots corp hq set; the corporation's headquarters NPC station from the corporation window. A saved HQ that is destroyed, unanchoring, no longer owned or without docking blocks recall with a message instead of diverting pilots.",
  "Recall to an NPC station uses the durable relocate operation (undock, route, warp, dock) and pauses each pilot once docked. Recall to a structure pauses the pilot at once and steps it there with the same stargate-route and dock helpers; docking permission is checked first, and pilots in an industry cycle are reported rather than pulled away.",
  "Paused pilots skip their own threat responses, so use structure recalls in safe space. /bots corp work resumes the corporation and cancels a pending recall; mining uses the HQ as its home only if its system is high-security with belts (and a structure has a quantum core), otherwise the nearest safe belts.",
  "Limits: recall and work orders are saved and re-issued after a server restart; a recall holds the corporation until a work order replaces it. Raise EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM (default 30) to at least the largest corporation, or the director will move pilots out of the HQ system after /bots corp work. Progress and results arrive as chat messages.",
  "Per-pilot equivalents: /playerbots route|dock|undock|pause|resume|op stop|mine|colony <bot> ... (listed above). /bots corp applies them to a whole corporation.",
].join("\n");

function withBotsHelp(session, chatHub, options, baseMessage) {
  return state.deps.replies().handledResult(
    chatHub, session, options, `${baseMessage}\n\n${BOTS_HELP_ADDENDUM}`,
  );
}

// Appended (never substituted) to the end of the /bots usage text; /bots help also gets the full section.
function usageSuffix(argumentText) {
  const concise = " | corp recall|work|status|hq|deposit|help [corporationID] (whole-corporation orders: recall pilots to the corporation HQ, dock and hold them, then put them to work)";
  return /^\s*help\s*$/i.test(String(argumentText || "")) ? `${concise}\n\n${BOTS_HELP_ADDENDUM}` : concise;
}

function handle(session, argumentText, chatHub, options = {}) {
  const replies = state.deps.replies();
  const reply = (message) => replies.handledResult(chatHub, session, options, message);
  const parsed = parseArguments(argumentText);
  if (parsed.subcommand === "help" || parsed.error) {
    return reply(parsed.error ? `${parsed.error}\n${HELP}` : BOTS_HELP_ADDENDUM);
  }
  if (!["recall", "work", "status", "hq", "deposit"].includes(parsed.subcommand)) {
    return reply(`Unknown /bots corp subcommand: ${parsed.subcommand}.\n${HELP}`);
  }
  const corporationID = parsed.corporationID ||
    positive(session && (session.corporationID || session.corpid));
  if (!corporationID) return reply("Give a corporationID, or select a character that belongs to a corporation.");
  if (!canControlCorporation(session, corporationID)) {
    return reply("You can only control playerbots in your own corporation; staff/admin can control any corporation.");
  }
  if (parsed.subcommand === "hq") return reply(commandHeadquarters(parsed, session, corporationID));
  if (parsed.subcommand === "deposit") return reply(commandDeposit(parsed, session, corporationID));
  const bots = botsOf(corporationID);
  if (!bots.length) return reply(`Corporation ${corporationID} has no playerbots to control.`);
  const context = { session, chatHub, options };
  if (parsed.subcommand === "status") return reply(commandStatus(corporationID, bots));
  if (parsed.subcommand === "recall") return reply(commandRecall(parsed, corporationID, bots, context));
  return reply(commandWork(parsed, corporationID, bots, context));
}

// Used by the corporation deposit: whether an HQ was saved with /bots corp hq
// set, and the HQ the corporation's pilots would be recalled to.
function hasSavedHeadquarters(corporationID) {
  return positive(savedHeadquarters()[String(positive(corporationID))]) > 0;
}

function getHeadquarters(corporationID) {
  return resolveHeadquarters(positive(corporationID), 0);
}

// ----------------------------------------------------- dashboard surface

// Standing recalls: [{ corporationID, whole, characterIDs, released }].
function listStandingRecalls() {
  const rows = [];
  for (const key of Object.keys(standingOrders())) {
    const corporationID = positive(key);
    const recall = corporationID && standingRecord(corporationID).recall;
    if (!recall) continue;
    const whole = !Array.isArray(recall.characterIDs);
    rows.push({
      corporationID,
      whole,
      characterIDs: whole ? [] : idList(recall.characterIDs),
      released: idList(recall.released),
      running: state.orders.has(corporationID),
    });
  }
  return rows;
}

function standingRecallIDs() {
  return listStandingRecalls().filter((row) => row.whole).map((row) => row.corporationID);
}

function getSavedHeadquartersID(corporationID) {
  return positive(savedHeadquarters()[String(positive(corporationID))]);
}

function listHeadquartersCandidates(corporationID) {
  const id = positive(corporationID);
  let structures = [];
  try { structures = state.deps.structures().listOwnedStructures(id, { refresh: false }) || []; } catch { structures = []; }
  return structures
    .filter((structure) => !structure.destroyedAt && !structure.unanchoring)
    .slice(0, 50)
    .map((structure) => ({
      structureID: positive(structure.structureID || structure.itemID),
      name: String(structure.itemName || structure.name || "Unnamed structure"),
      solarSystemID: positive(structure.solarSystemID),
      dockingOnline: !validateStructure(structure, id),
    }));
}

// Live progress of a corporation's orders, plus what is saved for a restart.
function describeOrders(corporationID) {
  const id = positive(corporationID);
  const rows = [];
  const record = standingRecord(id);
  const order = state.orders.get(id);
  if (order) {
    rows.push({
      kind: "recall",
      status: "running",
      scope: record.recall && Array.isArray(record.recall.characterIDs) ? "selected" : "corporation",
      destination: formatDestination(order.headquarters),
      total: order.total,
      done: order.held,
      failed: order.failed,
      pending: order.pending.size,
      startedAt: new Date(order.createdAt).toISOString(),
      failures: summarizeFailures(order.failures),
    });
  } else if (record.recall) {
    const recall = record.recall;
    const listed = Array.isArray(recall.characterIDs);
    rows.push({
      kind: "recall",
      status: recall.status || "holding",
      scope: listed ? "selected" : "corporation",
      pilots: listed ? recall.characterIDs.length : 0,
      released: idList(recall.released).length,
      held: Number(recall.held) || 0,
      failed: Number(recall.failed) || 0,
      startedAt: String(recall.createdAt || ""),
      finishedAt: String(recall.finishedAt || ""),
    });
  }
  const job = state.jobs.get(id);
  if (job) {
    const started = Object.values(job.counts).reduce((sum, count) => sum + count, 0);
    rows.push({
      kind: "work",
      status: "running",
      mode: job.mode,
      total: started + job.failures.length + job.pending.length,
      done: started,
      failed: job.failures.length,
      pending: job.pending.length,
      failures: summarizeFailures(job.failures),
    });
  } else if (record.work) {
    rows.push({
      kind: "work",
      status: "saved",
      mode: String(record.work.mode || ""),
      pending: idList(record.work.pending).length,
      startedAt: String(record.work.createdAt || ""),
    });
  }
  return rows;
}

function selectBots(corporationID, characterIDs) {
  const all = botsOf(corporationID);
  if (!Array.isArray(characterIDs) || !characterIDs.length) return all;
  const wanted = new Set(idList(characterIDs));
  const selected = all.filter((bot) => wanted.has(Number(bot.characterID)));
  selected.selection = true;
  return selected;
}

const DASHBOARD_ACTIONS = new Set(["recall", "work", "cancel", "hq-set", "hq-clear", "deposit", "pause", "resume"]);

/*
 * Structured corporation orders for the operator dashboard. No session: the
 * dashboard is the server operator, so corporation and CEO checks do not
 * apply. args: { characterIDs?, station?, mode?, trips?, target?, deposit?,
 * division? }. With characterIDs the order covers only those pilots and
 * leaves the rest of the corporation's orders alone.
 * Returns { success, message, orders }.
 */
function runCorporationCommand(corporationID, action, args = {}) {
  const id = positive(corporationID);
  const name = String(action || "").toLowerCase();
  const context = { source: "dashboard" };
  const done = (success, rawMessage) => {
    // Chat hints ("Progress: /bots corp status ...") mean nothing on the dashboard.
    const message = String(rawMessage || "")
      .replace(/ (Progress|Release them with)[^.]*\/bots corp[^.]*\./g, "")
      .replace(/; a summary follows\./, ".")
      .replace(/ (of|for) corporation \d+/g, "")
      .replace(/ \((system|station|structure) \d+\)/g, "")
      .replace(/^Deposit: /, "Mining and PI output: ")
      .replace(/\n?Mining and PI collection jobs started from now on[\s\S]*$/, "")
      .replace(/ \(no usable HQ right now; see \/bots corp hq\)/, " (no usable HQ right now)")
      .replace(/ \(automatic: an HQ is saved with \/bots corp hq set\)/, " (automatic: an HQ is saved)")
      .replace(/ \(automatic: no HQ saved; \/bots corp work still deposits\)/, " (automatic: no HQ saved; Send to work still deposits)")
      .replace(/; \/bots corp now uses/, "; orders now use")
      .replace(/ It is used by \/bots corp recall, work and status\./, "")
      .trim();
    appendCommandLog(id, { source: "dashboard", action: name, message, success });
    return { success, message, orders: describeOrders(id) };
  };
  if (!id) return { success: false, message: "A corporation is required." };
  if (!DASHBOARD_ACTIONS.has(name)) return { success: false, message: `Unknown corporation action: ${action}.` };
  if (name === "hq-set" || name === "hq-clear") {
    const target = positive(args.target);
    if (name === "hq-set" && !target) return { success: false, message: "Choose a station or structure for the HQ." };
    const message = commandHeadquarters({ hqAction: name === "hq-set" ? "set" : "clear", hqTarget: target }, null, id, { operator: true });
    return done(/^(HQ for corporation|Saved HQ cleared)/.test(message), message);
  }
  if (name === "deposit") {
    const allowed = ["on", "off", "auto", "deliveries", "hangar"];
    const depositAction = String(args.deposit || "").toLowerCase();
    if (!allowed.includes(depositAction)) return { success: false, message: "Choose on, off, auto, deliveries or hangar." };
    const message = commandDeposit({ depositAction, depositDivision: positive(args.division) }, null, id, { operator: true });
    return done(/^Deposit for corporation/.test(message), message);
  }
  if (name === "cancel") {
    cancelOrders(id);
    saveStandingOrder(id, null);
    return done(true, `Orders cancelled. Pilots keep their current pause state; use Send to work or Resume to release them.`);
  }
  const bots = selectBots(id, args.characterIDs);
  if (!bots.length) return { success: false, message: `Corporation ${id} has no matching playerbots.` };
  if (name === "pause" || name === "resume") {
    let affected = 0;
    const errors = [];
    for (const bot of bots) {
      try {
        const result = name === "pause" ? state.deps.tasks().pauseBot(bot) : state.deps.tasks().resumeBot(bot);
        if (result && result.success) affected += 1;
        else errors.push(`${bot.characterName}: ${result && result.message || "failed"}`);
      } catch (error) { errors.push(`${bot.characterName}: ${error.message}`); }
    }
    // Resuming is a release: the pilots leave any recall so a restart does not
    // pull them back to the HQ.
    if (name === "resume") {
      const ids = bots.map((bot) => Number(bot.characterID));
      if (bots.selection) releasePilots(id, ids);
      else { cancelOrders(id); releaseFromStandingRecall(id, null); }
    }
    return done(affected > 0, `${name === "pause" ? "Paused" : "Resumed"} ${affected} of ${bots.length} pilot(s).${errors.length ? ` ${errors.slice(0, 3).join("; ")}` : ""}`);
  }
  const parsed = {
    station: positive(args.station),
    mode: MODES.has(String(args.mode || "").toLowerCase()) ? String(args.mode).toLowerCase() : "auto",
    trips: Math.max(1, Math.min(20, positive(args.trips) || 1)),
  };
  const message = name === "recall"
    ? commandRecall(parsed, id, bots, context)
    : commandWork(parsed, id, bots, context);
  return done(/^(Recall ordered|Released)/.test(message), message);
}

// Re-issues saved recall and work orders after a restart.
function restoreStandingOrders() {
  const restored = [];
  for (const key of Object.keys(standingOrders())) {
    const corporationID = positive(key);
    if (!corporationID || state.orders.has(corporationID) || state.jobs.has(corporationID)) continue;
    const record = standingRecord(corporationID);
    const context = { source: "restore" };
    try {
      if (record.recall) {
        const recall = record.recall;
        const released = new Set(idList(recall.released));
        const bots = (Array.isArray(recall.characterIDs) ? selectBots(corporationID, recall.characterIDs) : botsOf(corporationID))
          .filter((bot) => !released.has(Number(bot.characterID)));
        const headquarters = resolveHeadquarters(corporationID, positive(recall.destinationID));
        if (headquarters.error) {
          appendCommandLog(corporationID, { source: "restore", action: "recall", success: false, message: `Could not re-issue the recall after a restart: ${headquarters.error}` });
        } else if (bots.length) {
          createRecallOrder(corporationID, headquarters, bots, context);
          ensureTimer();
          appendCommandLog(corporationID, { source: "restore", action: "recall", message: `Recall re-issued after a restart for ${bots.length} pilot(s) to ${formatDestination(headquarters)}.` });
          restored.push(corporationID);
        }
      }
      if (record.work) {
        const pending = new Set(idList(record.work.pending));
        const bots = botsOf(corporationID).filter((bot) => pending.has(Number(bot.characterID)));
        if (!bots.length) {
          updateStanding(corporationID, (next) => { next.work = null; });
        } else {
          bots.selection = true;
          const overrides = {};
          for (const [characterID, override] of Object.entries(record.work.overrides || {})) {
            const hq = resolveHeadquarters(corporationID, positive(override.destinationID));
            overrides[characterID] = { mode: override.mode, trips: override.trips, destinationID: positive(override.destinationID), headquarters: hq.error ? null : hq };
          }
          const message = commandWork({
            station: positive(record.work.destinationID),
            mode: MODES.has(record.work.mode) ? record.work.mode : "auto",
            trips: Math.max(1, Math.min(20, positive(record.work.trips) || 1)),
            overrides,
            restoring: true,
          }, corporationID, bots, context);
          appendCommandLog(corporationID, { source: "restore", action: "work", message: `Work order resumed after a restart: ${message.replace(/; a summary follows\./, ".")}` });
          if (!restored.includes(corporationID)) restored.push(corporationID);
        }
      }
    } catch (error) {
      warn(`Could not restore the standing order for corporation ${corporationID}: ${error.message}`);
    }
  }
  return restored;
}

module.exports = {
  runCorporationCommand,
  restoreStandingOrders,
  describeOrders,
  getCommandLog,
  appendCommandLog,
  listStandingRecallCorporationIDs: standingRecallIDs,
  listStandingRecalls,
  releasePilots,
  getSavedHeadquartersID,
  listHeadquartersCandidates,
  handle,
  hasSavedHeadquarters,
  getHeadquarters,
  withBotsHelp,
  usageSuffix,
  BOTS_HELP_ADDENDUM,
  configure,
  reset,
  _testing: {
    parseArguments, advanceRecall, startWorkForBot, tick, state, commandStatus,
    TICK_MS, BATCH_PER_TICK, MAX_RETRIES, STEP_DELAY_MS,
  },
};
