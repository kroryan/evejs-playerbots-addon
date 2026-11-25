"use strict";

// Corporation hangars instead of Corporation Deliveries. Deliveries cannot be
// opened in EveJS, so a corporation's goods go into its office hangar at
// headquarters, where players can see them, one division per kind of work:
//   1 Mining (ore and minerals)   2 Planetary (PI goods)   3 Industry
//   4 Trade                       5 Combat
// This runtime:
//   - grants every bot in a corporation, bot-run or player-run, the roles to
//     view and take from divisions 1-5 and from deliveries (nothing else);
//   - names those divisions in bot-run corporations;
//   - rents the office at headquarters for a bot-run corporation when its
//     bot CEO is docked there (a player corporation rents its own office).
// Without an office the goods still fall back to Corporation Deliveries.

const DIVISIONS = Object.freeze({ mining: 1, planetary: 2, industry: 3, trade: 4, combat: 5 });
const DIVISION_NAMES = Object.freeze({ 1: "Mining", 2: "Planetary", 3: "Industry", 4: "Trade", 5: "Combat" });
const KIND_DIVISION = Object.freeze({ mine: 1, "pi-collect": 2, industry: 3, "trade-run": 4, sell: 4, combat: 5 });
const FLAG_CORP_HANGAR_1 = 115;

// Role bits for divisions 1-5 (client appConst): hangar take, hangar query,
// container take; plus the three deliveries roles.
const HANGAR_TAKE = [8192n, 16384n, 32768n, 65536n, 131072n];
const HANGAR_QUERY = [1048576n, 2097152n, 4194304n, 8388608n, 16777216n];
const CONTAINER_TAKE = [4398046511104n, 8796093022208n, 17592186044416n, 35184372088832n, 70368744177664n];
const DELIVERIES = 2n | 4n | 8n;
const BOT_HANGAR_ROLES = [...HANGAR_TAKE, ...HANGAR_QUERY, ...CONTAINER_TAKE].reduce((mask, bit) => mask | bit, DELIVERIES);
const ROLE_FIELDS = ["roles", "rolesAtHQ", "rolesAtBase", "rolesAtOther"];
const CHECK_MS = 10 * 60 * 1000;

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function lazy(path) {
  let cached;
  return () => (cached ||= require(path));
}

const deps = {
  runtime: lazy("../corporation/corporationRuntimeState"),
  corporations: lazy("../corporation/corporationState"),
  playerBots: lazy("./playerBotRuntime"),
  space: lazy("./playerBotSpaceRuntime"),
  offices: () => new (require("../corporation/officeManagerService"))(),
  logger: lazy("../../utils/logger"),
};

const checkedAt = new Map(); // "corp:char" -> ms

function toMask(value) {
  try { return BigInt(String(value ?? "0")); } catch { return 0n; }
}

function divisionFor(kind) {
  return KIND_DIVISION[String(kind || "")] || DIVISIONS.mining;
}

function isBot(characterID) {
  try {
    const runtime = deps.playerBots();
    return typeof runtime.hasBotProfile === "function" && runtime.hasBotProfile(positive(characterID)) === true;
  } catch {
    return false;
  }
}

function isBotRun(corporationID) {
  const record = deps.corporations().getCorporationRecord(positive(corporationID)) || {};
  return isBot(record.ceoID);
}

// Give a bot the hangar roles for divisions 1-5 in its corporation, keeping
// every role it already has. Returns true when something changed.
function grantHangarRoles(corporationID, characterID) {
  const corp = positive(corporationID);
  const id = positive(characterID);
  if (!corp || !id || !isBot(id)) return false;
  const key = `${corp}:${id}`;
  if (Date.now() - (checkedAt.get(key) || 0) < CHECK_MS) return false;
  checkedAt.set(key, Date.now());
  const runtime = deps.runtime();
  const member = runtime.getCorporationMember(corp, id);
  if (!member) return false;
  if (ROLE_FIELDS.every((field) => (toMask(member[field]) & BOT_HANGAR_ROLES) === BOT_HANGAR_ROLES)) return false;
  runtime.updateCorporationRuntime(corp, (corporation) => {
    const current = corporation.members && corporation.members[String(id)];
    if (!current) return corporation;
    for (const field of ROLE_FIELDS) current[field] = (toMask(current[field]) | BOT_HANGAR_ROLES).toString();
    return corporation;
  });
  try { runtime.syncMemberStateToCharacterRecord(corp, id); } catch { /* the runtime record is authoritative */ }
  return true;
}

// Bot-run corporations name divisions 1-5 after their work.
function nameDivisions(corporationID) {
  const corp = positive(corporationID);
  if (!corp || !isBotRun(corp)) return false;
  const runtime = deps.runtime();
  const names = runtime.getCorporationDivisionNames(corp) || {};
  if (Object.entries(DIVISION_NAMES).every(([index, name]) => names[index] === name)) return false;
  runtime.updateCorporationRuntime(corp, (corporation) => {
    corporation.divisionNames = { ...(corporation.divisionNames || {}) };
    for (const [index, name] of Object.entries(DIVISION_NAMES)) {
      if (!corporation.divisionNames[index] || /^Division \d$/.test(corporation.divisionNames[index])) {
        corporation.divisionNames[index] = name;
      }
    }
    return corporation;
  });
  return true;
}

function officeAt(corporationID, stationID) {
  const offices = deps.runtime().getCorporationOffices(positive(corporationID)) || [];
  const list = Array.isArray(offices) ? offices : Object.values(offices);
  return list.find((office) => office && positive(office.stationID) === positive(stationID) && !office.impounded) || null;
}

function officeLocationID(office) {
  return office ? positive(office.officeID) || positive(office.officeFolderID) || positive(office.itemID) : 0;
}

// The office at headquarters, renting it first when the bot is the bot-run
// corporation's CEO and is docked there. Returns the office or null.
async function ensureOffice(bot, corporationID, stationID) {
  const corp = positive(corporationID);
  const station = positive(stationID);
  let office = officeAt(corp, station);
  if (office || !bot) return office;
  const record = deps.corporations().getCorporationRecord(corp) || {};
  if (positive(record.ceoID) !== positive(bot.characterID) || !isBot(bot.characterID)) return null;
  try {
    const session = deps.space().getActorSession(bot);
    if (positive(session.stationid || session.stationID || session.structureid || session.structureID) !== station) return null;
    await deps.offices().Handle_RentOffice([], session);
    office = officeAt(corp, station);
    if (office) deps.logger().info(`[PlayerBots] Corporation ${corp} rented an office at ${station} for its hangars.`);
  } catch (error) {
    deps.logger().warn(`[PlayerBots] Corporation ${corp} could not rent an office at ${station}: ${String(error && (error.message || error)).slice(0, 160)}`);
  }
  return office;
}

// Everything a deposit needs before it files goods: the bot's roles, the
// division names and the office. Returns { locationID, flagID, division,
// label } for the office hangar, or null to use Corporation Deliveries.
async function prepareDeposit(bot, corporationID, stationID, kind) {
  const corp = positive(corporationID);
  try {
    grantHangarRoles(corp, bot && bot.characterID);
    nameDivisions(corp);
  } catch (error) {
    deps.logger().warn(`[PlayerBots] Hangar roles for corporation ${corp}: ${error.message}`);
  }
  const office = await ensureOffice(bot, corp, stationID);
  const locationID = officeLocationID(office);
  if (!locationID) return null;
  const division = divisionFor(kind);
  return {
    locationID,
    flagID: FLAG_CORP_HANGAR_1 + division - 1,
    division,
    label: `corporation hangar ${division} (${DIVISION_NAMES[division]})`,
  };
}

// Director pass: every bot gets its hangar roles, in bot and player
// corporations alike.
function grantRolesToRoster(bots = []) {
  let changed = 0;
  for (const bot of bots) {
    try {
      if (grantHangarRoles(bot.corporationID, bot.characterID)) changed += 1;
    } catch { /* next pass */ }
  }
  return changed;
}

module.exports = {
  BOT_HANGAR_ROLES,
  DIVISIONS,
  DIVISION_NAMES,
  divisionFor,
  ensureOffice,
  grantHangarRoles,
  grantRolesToRoster,
  nameDivisions,
  prepareDeposit,
  _testing: { deps, reset() { checkedAt.clear(); } },
};
