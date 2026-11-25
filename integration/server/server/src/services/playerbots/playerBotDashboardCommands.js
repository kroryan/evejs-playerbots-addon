"use strict";

// Per-pilot orders from the operator dashboard. Each action calls the same
// runtime functions as its /playerbots chat command (pause, resume, op stop,
// op resume, mine, colony, combat, upgrade); the dashboard acts as the server
// operator, so no corporation or fleet check applies. Results are written to
// the pilot's corporation command log.

const MAX_PILOTS_PER_REQUEST = 50;
const ACTIONS = Object.freeze({
  pause: "Pause",
  resume: "Resume",
  stop: "Stop current operation",
  "resume-op": "Resume operation",
  mine: "Mine",
  colony: "Set up a PI colony",
  combat: "Combat patrol",
  upgrade: "Upgrade ship",
});
const COMBAT_MODES = new Set(["security", "war", "piracy", "nullsec-conflict", "gate-camp"]);
const UPGRADE_ROLES = new Set(["mining", "logistics", "security", "piracy", "sovereignty", "trade"]);
const STARTS = new Set(["mine", "colony", "combat", "upgrade", "resume-op"]);

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function createDashboardCommands(deps = {}) {
  const playerBots = () => deps.playerBots || require("./playerBotRuntime");
  const operations = () => deps.operations || require("./playerBotOperationRuntime");
  const tasks = () => deps.tasks || require("./playerBotTaskRuntime");
  const autonomy = () => deps.autonomy || require("./playerBotAutonomyRuntime");
  const corpCommands = () => deps.corpCommands || require("./playerBotCorpCommands");
  const logger = () => deps.logger || require("../../utils/logger");

  function findBot(characterID) {
    const runtime = playerBots();
    if (typeof runtime.getBotByCharacterID === "function") return runtime.getBotByCharacterID(characterID);
    return runtime.listBots().find((bot) => Number(bot.characterID) === characterID) || null;
  }

  function runOne(bot, action, args) {
    const name = bot.characterName;
    switch (action) {
      case "pause": {
        const result = tasks().pauseBot(bot);
        return result.success ? { success: true, message: `${name} paused.` } : result;
      }
      case "resume": {
        const result = tasks().resumeBot(bot);
        if (!result.success) return result;
        // A resumed pilot leaves any corporation recall, so a restart does not
        // pull it back to the HQ.
        try { corpCommands().releasePilots(bot.corporationID, [bot.characterID]); } catch { /* recall bookkeeping is optional */ }
        return { success: true, message: `${name} resumed.` };
      }
      case "stop":
        return operations().stopOperation(name);
      case "resume-op":
        return operations().resumeOperation(name);
      case "mine":
        return operations().startMining(name, Math.max(1, Math.min(20, positive(args.trips) || 1)), {
          stationID: positive(args.station) || null,
          refine: args.refine !== false,
          sell: args.sell !== false,
        });
      case "colony":
        return operations().startColony(name);
      case "combat": {
        const mode = String(args.mode || bot.specialty || "").toLowerCase();
        return operations().startCombat(name, COMBAT_MODES.has(mode) ? mode : String(bot.specialty || "security"));
      }
      case "upgrade": {
        // No role given: combat specialties climb their own ladder, the rest mine.
        const requested = String(args.role || "").toLowerCase();
        const specialty = String(bot.specialty || "").toLowerCase();
        const role = UPGRADE_ROLES.has(requested) ? requested : UPGRADE_ROLES.has(specialty) ? specialty : "mining";
        return operations().startShipUpgrade(name, role, { force: args.force === true });
      }
      default:
        return { success: false, message: `Unknown pilot action: ${action}.` };
    }
  }

  /*
   * characterIDs: up to 50 pilots; action: one of ACTIONS; args depend on the
   * action (mine: trips, station; combat: mode; upgrade: role, force).
   * Returns { success, message, results: [{characterID, success, message}] }.
   */
  function runBotCommand(characterIDs, action, args = {}) {
    const name = String(action || "").toLowerCase();
    if (!ACTIONS[name]) return { success: false, message: `Unknown pilot action: ${action}.` };
    const ids = [...new Set((Array.isArray(characterIDs) ? characterIDs : [characterIDs]).map(positive).filter(Boolean))];
    if (!ids.length) return { success: false, message: "Choose at least one pilot." };
    if (ids.length > MAX_PILOTS_PER_REQUEST) {
      return { success: false, message: `Send at most ${MAX_PILOTS_PER_REQUEST} pilots per request.` };
    }
    const results = [];
    const byCorporation = new Map();
    for (const characterID of ids) {
      const bot = findBot(characterID);
      if (!bot) {
        results.push({ characterID, success: false, message: "Not a playerbot." });
        continue;
      }
      let result;
      try {
        result = runOne(bot, name, args || {}) || { success: false, message: "No result." };
      } catch (error) {
        result = { success: false, message: error.message || String(error) };
      }
      const success = result.success === true;
      const message = String(result.message || (success ? "Done." : "Refused.")).slice(0, 300);
      results.push({ characterID, characterName: bot.characterName, success, message });
      // A paused pilot's operation would wait forever: an operator's order to
      // start work also resumes the pilot and lifts any corporation recall.
      if (success && STARTS.has(name) && (bot.status === "paused" || bot.autonomyPaused === true)) {
        try {
          const resumed = tasks().resumeBot(bot);
          if (resumed && resumed.success) {
            try { corpCommands().releasePilots(bot.corporationID, [bot.characterID]); } catch { /* optional */ }
            results[results.length - 1].message += " The pilot was paused and has been resumed.";
          }
        } catch (error) {
          results[results.length - 1].message += ` The pilot is paused and could not be resumed (${error.message}); resume it so the job can run.`;
        }
      }
      if (success && STARTS.has(name)) {
        try {
          Promise.resolve(autonomy().ensureIndustryCycleStep(characterID)).catch((error) => {
            logger().warn(`[PlayerBotsDashboard] Planner wake failed for ${characterID}: ${error.message}`);
          });
        } catch { /* planner optional */ }
      }
      const corporationID = positive(bot.corporationID);
      if (corporationID) {
        const entry = byCorporation.get(corporationID) || { ok: 0, failed: 0, names: [], errors: [] };
        if (success) entry.ok += 1; else entry.failed += 1;
        if (entry.names.length < 3) entry.names.push(bot.characterName);
        if (!success && entry.errors.length < 2) entry.errors.push(`${bot.characterName}: ${message}`);
        byCorporation.set(corporationID, entry);
      }
    }
    const succeeded = results.filter((row) => row.success).length;
    const summary = ids.length === 1
      ? results[0].message
      : `${ACTIONS[name]}: ${succeeded} of ${ids.length} pilot(s) accepted.`;
    try {
      const log = corpCommands();
      for (const [corporationID, entry] of byCorporation) {
        log.appendCommandLog(corporationID, {
          source: "dashboard",
          action: `pilot ${name}`,
          success: entry.failed === 0,
          message: ids.length === 1
            ? `${entry.names[0]}: ${summary}`
            : `${ACTIONS[name]} for ${entry.ok + entry.failed} pilot(s) (${entry.names.join(", ")}${entry.ok + entry.failed > entry.names.length ? ", …" : ""}): ${entry.ok} accepted${entry.failed ? `, ${entry.failed} refused (${entry.errors.join("; ")})` : ""}.`,
        });
      }
    } catch (error) {
      logger().warn(`[PlayerBotsDashboard] Could not write the command log: ${error.message}`);
    }
    return { success: succeeded > 0, message: summary, results };
  }

  return Object.freeze({ runBotCommand, ACTIONS, MAX_PILOTS_PER_REQUEST });
}

module.exports = { createDashboardCommands, ACTIONS, MAX_PILOTS_PER_REQUEST };
