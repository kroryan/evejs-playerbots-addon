"use strict";

// One activity state per playerbot for the operator dashboard, with a plain
// sentence for what the pilot is doing and, when it is not working, why.
// Pure functions: the dashboard runtime gathers the inputs and calls
// classifyBotActivity once per pilot per snapshot.

const STATES = Object.freeze([
  { id: "working", label: "Working" },
  { id: "travelling", label: "Travelling" },
  { id: "holding", label: "Holding" },
  { id: "queued", label: "Queued" },
  { id: "cooling", label: "Cooling down" },
  { id: "paused", label: "Paused" },
  { id: "standby", label: "Standing by" },
  { id: "idle", label: "Idle" },
  { id: "offline", label: "Offline" },
]);
const STATE_IDS = new Set(STATES.map((state) => state.id));
const STATE_LABELS = Object.freeze(Object.fromEntries(STATES.map((state) => [state.id, state.label])));

const KIND_LABELS = Object.freeze({
  "accept": "Accepting a contract",
  "agent-mission": "Running an agent mission",
  "alliance-courier": "Running an alliance courier",
  "alliance-founding": "Founding an alliance",
  "blueprint": "Buying a blueprint",
  "capsule-recovery": "Recovering from a lost ship",
  "colony": "Setting up a PI colony",
  "combat": "Patrolling for combat",
  "corp-recall": "Returning to corporation HQ",
  "engage": "Engaging a target",
  "fuel": "Delivering structure fuel",
  "industry": "Running an industry cycle",
  "load-package": "Loading a package",
  "loot": "Looting",
  "material": "Buying materials",
  "mine": "Mining",
  "mining": "Mining",
  "module": "Buying modules",
  "neutral-hub": "Visiting a trade hub",
  "order-build": "Building a player order",
  "order-courier": "Couriering a player order",
  "pi-collect": "Collecting PI exports",
  "relocate": "Relocating",
  "retreat": "Retreating",
  "sell": "Selling goods",
  "ship": "Buying a ship",
  "sovereignty": "Working on sovereignty",
  "station": "Building a station",
  "structure": "Working on a structure",
  "structure-core-install": "Installing a quantum core",
  "structure-deployment": "Deploying a structure",
  "structure-procurement": "Buying a structure",
  "structure-service-provision": "Supplying structure services",
  "trade-run": "Running goods to the trade hub",
  "unload-package": "Unloading a package",
  "upgrade": "Upgrading ship",
});

const STAGE_LABELS = Object.freeze({
  "agent": "travelling to the agent",
  "objective": "working on the mission objective",
  "pickup": "collecting the courier package",
  "site": "travelling to the mission site",
  "turn-in": "returning for the mission hand-in",
  "share": "paying the corporation's share",
  "acquire-blueprint": "getting the blueprint",
  "acquire-materials": "getting materials",
  "buy": "buying",
  "buy-at-source": "buying at the source",
  "choose-source": "choosing a source",
  "collect": "collecting",
  "deliver": "delivering",
  "deploy": "deploying",
  "engage": "engaging",
  "escaping-interdiction": "escaping an interdiction",
  "fit": "fitting the ship",
  "in-transit": "in transit",
  "inside-interdiction": "inside an interdiction",
  "install": "installing",
  "install-core": "installing the core",
  "interdiction-detour": "detouring around an interdiction",
  "interdiction-hold": "holding for an interdiction",
  "jita-run": "flying to Jita",
  "list": "listing goods for sale",
  "load": "loading cargo",
  "manufacturing": "manufacturing",
  "market-sell": "selling on the market",
  "mining": "mining",
  "planting": "placing planet pins",
  "retreat": "retreating",
  "return": "returning",
  "return-to-jita": "returning to Jita",
  "return-to-source": "returning to the source",
  "sell": "selling",
  "site-engage": "fighting at a site",
  "site-loot": "looting a site",
  "to-anomaly": "flying to an anomaly",
  "to-belt": "flying to a belt",
  "to-colony-system": "flying to the colony system",
  "to-core": "flying to the structure",
  "to-destination": "flying to the destination",
  "to-home": "flying home",
  "to-jita": "flying to Jita",
  "to-market": "flying to market",
  "to-order": "flying to the order",
  "to-purchase-source": "flying to buy",
  "to-source": "flying to pickup",
  "to-structure": "flying to the structure",
  "to-system": "flying to the system",
  "travel": "travelling",
  "undock": "undocking",
  "undocking": "undocking",
  "unload": "unloading",
  "waiting-for-gate": "waiting at a gate",
});

const TRAVEL_STAGE = /^(to-|return|travel|in-transit|undock|jita-run|waiting-for-gate|interdiction-detour|escaping-interdiction)/;
const HOLDING_STATUSES = new Set(["holding", "review", "blocked"]);

const REASONS = Object.freeze({
  "autowork-off": "Autonomous work is off",
  "seeding": "Autonomous work is off while the roster seeds",
  "operator-pause": "Paused by an operator",
  "corp-hold": "Held at HQ by a corporation order",
  "corp-recall": "Waiting for its corporation recall to start",
  "pi-slot": "Waiting for a PI setup slot",
  "task": "Waiting on a queued task",
  "cooldown": "Cooling down after a failed assignment",
  "unassigned": "Waiting for the director",
  "offline": "Rotated out of the online set",
});

function slugToWords(value) {
  return String(value || "").replace(/[-_]+/g, " ").trim();
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function kindLabel(kind) {
  const key = String(kind || "").toLowerCase();
  return KIND_LABELS[key] || capitalize(slugToWords(key) || "Working");
}

function stageLabel(stage) {
  const key = String(stage || "").toLowerCase();
  return STAGE_LABELS[key] || slugToWords(key);
}

// "Collecting PI exports: flying to pickup"
function describeWork(kind, stage) {
  const head = kindLabel(kind);
  const tail = stageLabel(stage);
  return tail && !["done", "next", "unknown"].includes(String(stage).toLowerCase()) ? `${head}: ${tail}` : head;
}

function isTravelStage(stage) {
  return TRAVEL_STAGE.test(String(stage || "").toLowerCase());
}

function cleanText(value, limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

// Groups similar director messages ("System 30002505 already has 81 ...") so
// the dashboard can count them.
function reasonGroupKey(message) {
  return cleanText(message, 200)
    .replace(/\b\d[\d,.]*\b/g, "#")
    .replace(/"[^"]*"/g, "\"…\"")
    .slice(0, 120);
}

/*
 * input = {
 *   bot,            roster profile (status, autonomyPaused, specialty, ...)
 *   connected,      boolean, in the current online set
 *   activeWork,     active operation or industry cycle ({kind,status,stage,lastAction,updatedAt}) or null
 *   queuedWork,     queued PI setup ({reason, queuedAt}) or null
 *   tasks,          queued/leased tasks for this pilot
 *   assignment,     director assignment record ({cooldownUntil,lastAssignment,lastMessage})
 *   corpHold,       true when a standing corporation recall holds this pilot
 *   autowork,       { enabled, seeding: { active, rosterCount, target } }
 *   now,            ms
 * }
 */
function classifyBotActivity(input = {}) {
  const bot = input.bot || {};
  const now = Number(input.now) || Date.now();
  const work = input.activeWork || null;
  const paused = bot.status === "paused" || bot.autonomyPaused === true;
  const assignment = input.assignment || {};
  const autowork = input.autowork || { enabled: true };

  // A paused pilot's operation does not advance (advanceOperation waits), so
  // it is paused, not working, unless a corporation recall is moving it.
  if (work && paused && !input.corpHold) {
    return {
      state: "paused",
      activity: String(work.kind || ""),
      doing: `Paused during: ${describeWork(work.kind, work.stage)}`,
      reason: REASONS["operator-pause"],
      reasonCode: "operator-pause",
      since: String(work.updatedAt || ""),
    };
  }
  if (work && paused) {
    return {
      state: "travelling",
      activity: "corp-recall",
      doing: "Returning to corporation HQ",
      reason: cleanText(work.lastAction || "Moved by a corporation recall"),
      reasonCode: "",
      since: String(work.updatedAt || ""),
    };
  }
  if (work) {
    const status = String(work.status || "").toLowerCase();
    const kind = String(work.kind || "other").toLowerCase();
    const stage = String(work.stage || "");
    const state = HOLDING_STATUSES.has(status) ? "holding" : isTravelStage(stage) ? "travelling" : "working";
    return {
      state,
      activity: kind,
      doing: describeWork(kind, stage),
      reason: cleanText(work.lastAction || work.lastError || (state === "holding" ? `Operation is ${status}` : "")),
      reasonCode: state === "holding" ? `holding-${status}` : "",
      since: String(work.updatedAt || work.startedAt || ""),
    };
  }
  if (paused) {
    const code = input.corpHold ? "corp-hold" : "operator-pause";
    return { state: "paused", activity: "", doing: input.corpHold ? "Held at corporation HQ" : "Paused", reason: REASONS[code], reasonCode: code, since: "" };
  }
  if (input.corpHold && input.corpRecallRunning) {
    return { state: "queued", activity: "corp-recall", doing: "Waiting to be recalled to HQ", reason: REASONS["corp-recall"], reasonCode: "corp-recall", since: "" };
  }
  if (input.queuedWork) {
    return {
      state: "queued",
      activity: "colony",
      doing: "Waiting to set up a PI colony",
      reason: cleanText(input.queuedWork.reason || REASONS["pi-slot"]),
      reasonCode: "pi-slot",
      since: input.queuedWork.queuedAt ? new Date(Number(input.queuedWork.queuedAt)).toISOString() : "",
    };
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasks.length) {
    const task = tasks[0];
    return {
      state: "queued",
      activity: String(task.kind || "task"),
      doing: `Task: ${slugToWords(String(task.kind || "task").replace(/^playerbot\./, ""))}${task.status ? ` (${task.status})` : ""}`,
      reason: REASONS.task,
      reasonCode: "task",
      since: String(task.updatedAt || ""),
    };
  }
  if (input.connected === false) {
    return { state: "offline", activity: "", doing: "Offline", reason: REASONS.offline, reasonCode: "offline", since: "" };
  }
  if (autowork.enabled === false) {
    const seeding = autowork.seeding || {};
    const code = seeding.active ? "seeding" : "autowork-off";
    const reason = seeding.active
      ? `${REASONS.seeding} (${Number(seeding.rosterCount || 0).toLocaleString("en-US")} of ${Number(seeding.target || 0).toLocaleString("en-US")})`
      : REASONS["autowork-off"];
    return { state: "standby", activity: "", doing: "Standing by", reason, reasonCode: code, since: "" };
  }
  const cooldownUntil = Number(assignment.cooldownUntil) || 0;
  if (cooldownUntil > now) {
    const message = cleanText(assignment.lastMessage) || REASONS.cooldown;
    return {
      state: "cooling",
      activity: String(assignment.lastAssignment || ""),
      doing: assignment.lastAssignment ? `Retrying ${kindLabel(assignment.lastAssignment).toLowerCase()} later` : "Cooling down",
      reason: message,
      reasonCode: "cooldown",
      reasonGroup: reasonGroupKey(message),
      retryAt: new Date(cooldownUntil).toISOString(),
      since: "",
    };
  }
  return {
    state: "idle",
    activity: "",
    doing: "Idle",
    reason: assignment.lastMessage ? `Last director note: ${cleanText(assignment.lastMessage, 200)}` : REASONS.unassigned,
    reasonCode: "unassigned",
    since: "",
  };
}

function reasonLabel(code) {
  if (REASONS[code]) return REASONS[code];
  if (String(code).startsWith("holding-")) return `Operation ${String(code).slice(8)}`;
  return capitalize(slugToWords(code));
}

module.exports = {
  STATES,
  STATE_IDS,
  STATE_LABELS,
  KIND_LABELS,
  REASONS,
  classifyBotActivity,
  describeWork,
  isTravelStage,
  kindLabel,
  reasonGroupKey,
  reasonLabel,
  stageLabel,
};
