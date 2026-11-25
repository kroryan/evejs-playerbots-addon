"use strict";

// Bot alliances. Corporations band together like players do, through the
// game's own alliance authority: the founding corporation's CEO creates the
// alliance (1B ISK fee, Empire Control), the other CEOs apply, and the
// executor accepts; membership takes effect after the usual 24 hours.
//
// Where alliance plans come from (setting allianceMode):
//   0 off: only alliances designed on the dashboard;
//   1 karma (default): corporations that share an enemy (hostile to, or at
//     war with, the same corporation) and hold no grudge against each other
//     form a coalition;
//   2 population: bot corporations of the same empire band together at once,
//     up to four per alliance.
// Dashboard designs (name, ticker, description, logo, founder and members)
// always run. Automatic alliances take famous names from science fiction.
// The founder's CEO is trained in Empire Control and handed the founding fee
// as an operator grant (outside capital, never profit).

const TABLE = "playerBots";
const STORE_PATH = "/_allianceDesigns";
const PASS_MS = 10 * 60 * 1000;
const MAX_CORPS_PER_ALLIANCE = 6;
const POPULATION_GROUP = 4;
const ALLIANCE_FOUNDING_COST = 1_000_000_000;
const EMPIRE_CONTROL = 3732;
const APPLICATION_ACCEPTED = 2;
const MAX_LOGO_BYTES = 300_000;

// [name, ticker]: famous alliances, federations and coalitions of science
// fiction. Names already taken in game are skipped.
const SCI_FI_ALLIANCES = Object.freeze([
  ["Rebel Alliance", "REBEL"], ["Interstellar Alliance", "ISA"], ["Earth Alliance", "EARTH"],
  ["Systems Alliance", "SYSAL"], ["United Federation of Planets", "UFP"], ["Terran Federation", "TERRA"],
  ["Outer Planets Alliance", "OPA"], ["Galactic Federation", "GFED"], ["Systems Commonwealth", "COMM"],
  ["Hegemony of Man", "HEG"], ["Terran Dominion", "DOMIN"], ["Klingon Empire", "KLING"],
  ["Romulan Star Empire", "RSE"], ["Cardassian Union", "CARD"], ["Minbari Federation", "MINB"],
  ["Centauri Republic", "CENT"], ["Narn Regime", "NARN"], ["Galactic Republic", "GREP"],
  ["Confederacy of Independent Systems", "CIS"], ["Twelve Colonies", "COLON"], ["Spacing Guild", "GUILD"],
  ["The Landsraad", "LANDS"], ["Grand Alliance", "GRAND"], ["Covenant", "COVEN"],
  ["United Nations Space Command", "UNSC"], ["Citadel Council", "CITA"], ["Terminus Alliance", "TERM"],
  ["Galactic Empire", "GEMP"], ["The Culture", "CULT"], ["Earth Defense Force", "EDF"],
  ["United Earth", "UE"], ["Lucian Alliance", "LUCI"], ["Free Jaffa Nation", "JAFFA"],
  ["Tau Empire", "TAU"], ["Kree Empire", "KREE"], ["Nova Corps", "NOVA"],
  ["Shi'ar Imperium", "SHIAR"], ["Martian Congressional Republic", "MCR"], ["Foundation", "FOUND"],
  ["Galactic Commonwealth", "GCOM"], ["Interstellar Commonwealth", "ICOM"], ["Mars Directorate", "MARS"],
]);

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function lazy(path) {
  let cached;
  return () => (cached ||= require(path));
}

const deps = {
  corporations: lazy("../corporation/corporationState"),
  characters: lazy("../character/characterState"),
  playerBots: lazy("./playerBotRuntime"),
  space: lazy("./playerBotSpaceRuntime"),
  grievances: lazy("./playerBotGrievanceRuntime"),
  wars: lazy("../corporation/warRuntimeState"),
  logger: lazy("../../utils/logger"),
  settings: () => require("./playerBotConfigurationRuntime").getSettings(),
  skills: lazy("../skills/skillState"),
  wallet: lazy("../account/walletState"),
  corpRegistry: () => new (require("../corporation/corpRegistryRuntime"))(),
  allianceRegistry: () => new (require("../corporation/allianceRegistryRuntime"))(),
  applications: lazy("../corporation/allianceApplicationState"),
  founding: lazy("../corporation/allianceFoundingState"),
  formation: lazy("../corporation/allianceFormationEligibility"),
  images: lazy("../corporation/allianceImageStore"),
  store: () => {
    const repo = require("../../gameStore/tableRepository").createTableRepository("service:playerbots", { strict: true });
    return {
      read() {
        repo.ensureTable(TABLE);
        const result = repo.read(TABLE, STORE_PATH);
        return result.success && result.data && typeof result.data === "object" ? result.data : {};
      },
      write(value) {
        repo.ensureTable(TABLE);
        repo.write(TABLE, STORE_PATH, value);
      },
    };
  },
};

let state = null;
let lastPassAtMs = 0;
let running = false;

function load() {
  if (state) return state;
  try {
    state = { designs: [], ...JSON.parse(JSON.stringify(deps.store().read())) };
  } catch {
    state = { designs: [] };
  }
  if (!Array.isArray(state.designs)) state.designs = [];
  return state;
}

function save() {
  try { deps.store().write(state); } catch (error) { warn(`could not save alliance plans: ${error.message}`); }
}

function warn(message) {
  try { deps.logger().warn(`[PlayerBots] Alliances: ${message}`); } catch { /* logging only */ }
}

function info(message) {
  try { deps.logger().info(`[PlayerBots] Alliances: ${message}`); } catch { /* logging only */ }
}

function allianceMode() {
  try {
    const mode = Math.trunc(Number(deps.settings().allianceMode));
    return [0, 1, 2].includes(mode) ? mode : 1;
  } catch {
    return 1;
  }
}

function corporation(corporationID) {
  try { return deps.corporations().getCorporationRecord(positive(corporationID)) || null; } catch { return null; }
}

// Bot-run corporations: their CEO is a bot.
function botCorporations(bots) {
  const byID = new Map();
  const botIDs = new Set(bots.map((bot) => positive(bot.characterID)));
  for (const bot of bots) {
    const corporationID = positive(bot.corporationID);
    if (!corporationID || byID.has(corporationID)) continue;
    const record = corporation(corporationID);
    if (!record || !botIDs.has(positive(record.ceoID))) continue;
    const ceo = bots.find((entry) => positive(entry.characterID) === positive(record.ceoID));
    byID.set(corporationID, {
      corporationID,
      allianceID: positive(record.allianceID),
      ceo,
      raceID: positive((deps.characters().getCharacterRecord(positive(record.ceoID)) || {}).raceID),
      members: bots.filter((entry) => positive(entry.corporationID) === corporationID).length,
    });
  }
  return byID;
}

function nameTaken(name, shortName) {
  try {
    const owners = deps.corporations();
    return Boolean(owners.findAllianceByExactName(name) || owners.findCorporationByName(name) ||
      owners.findAllianceByShortName(shortName) || owners.findCorporationByTickerName(shortName));
  } catch {
    return false;
  }
}

function nextSciFiName() {
  const used = new Set(load().designs.map((design) => design.name.toLowerCase()));
  for (const [name, ticker] of SCI_FI_ALLIANCES) {
    if (used.has(name.toLowerCase()) || nameTaken(name, ticker)) continue;
    return { name, ticker };
  }
  return null;
}

// Corporations sharing an enemy, without a grudge between them.
function karmaCoalitions(corps) {
  const enemies = new Map(); // corporationID -> Set of enemy corporations
  let overview = { grievances: [] };
  try { overview = deps.grievances().getOverview(); } catch { /* none yet */ }
  const add = (own, enemy) => {
    if (!corps.has(own)) return;
    if (!enemies.has(own)) enemies.set(own, new Set());
    enemies.get(own).add(enemy);
  };
  for (const row of overview.grievances || []) if (row.hostile || row.atWar) add(row.victim.corporationID, row.aggressor.corporationID);
  try {
    for (const war of deps.wars().listAllWars()) {
      if (war.timeFinished) continue;
      add(positive(war.declaredByID), positive(war.againstID));
      add(positive(war.againstID), positive(war.declaredByID));
    }
  } catch { /* no wars */ }
  const hostileBetween = (left, right) => {
    try { return deps.grievances().isHostileCorporation(left, right) || deps.grievances().isHostileCorporation(right, left); } catch { return false; }
  };
  const groups = [];
  const placed = new Set();
  for (const [corporationID, foes] of enemies) {
    if (placed.has(corporationID)) continue;
    const group = [corporationID];
    for (const [otherID, otherFoes] of enemies) {
      if (otherID === corporationID || placed.has(otherID) || group.length >= MAX_CORPS_PER_ALLIANCE) continue;
      if (foes.has(otherID) || otherFoes.has(corporationID)) continue;
      if (![...foes].some((foe) => otherFoes.has(foe))) continue;
      if (group.some((member) => hostileBetween(member, otherID))) continue;
      group.push(otherID);
    }
    if (group.length > 1) {
      for (const id of group) placed.add(id);
      groups.push(group);
    }
  }
  return groups;
}

function populationGroups(corps) {
  const byRace = new Map();
  for (const entry of corps.values()) {
    if (entry.allianceID) continue;
    if (!byRace.has(entry.raceID)) byRace.set(entry.raceID, []);
    byRace.get(entry.raceID).push(entry.corporationID);
  }
  const groups = [];
  for (const ids of byRace.values()) {
    ids.sort((left, right) => left - right);
    for (let index = 0; index + 1 < ids.length; index += POPULATION_GROUP) groups.push(ids.slice(index, index + POPULATION_GROUP));
  }
  return groups;
}

function designFor(corporationID) {
  return load().designs.find((design) => design.status !== "done-failed" &&
    (design.founderCorporationID === corporationID || design.memberCorporationIDs.includes(corporationID))) || null;
}

// Turn coalitions into designs: join an existing bot alliance when one of
// the group already has one, else found a new one led by the biggest corp.
function planAutomatic(corps) {
  const mode = allianceMode();
  if (mode === 0) return;
  const groups = mode === 2 ? populationGroups(corps) : karmaCoalitions(corps);
  for (const group of groups) {
    const free = group.filter((id) => !designFor(id));
    const existing = group.map((id) => designFor(id)).find(Boolean) ||
      load().designs.find((design) => design.allianceID && group.some((id) => corps.get(id)?.allianceID === design.allianceID));
    if (existing) {
      for (const id of free) {
        if (!corps.get(id).allianceID && existing.memberCorporationIDs.length + 1 < MAX_CORPS_PER_ALLIANCE &&
            !existing.memberCorporationIDs.includes(id) && existing.founderCorporationID !== id) {
          existing.memberCorporationIDs.push(id);
          if (existing.status === "formed") existing.status = "recruiting";
        }
      }
      continue;
    }
    const candidates = free.filter((id) => !corps.get(id).allianceID)
      .sort((left, right) => corps.get(right).members - corps.get(left).members || left - right);
    if (candidates.length < 2) continue;
    const name = nextSciFiName();
    if (!name) return;
    load().designs.push({
      id: `auto-${Date.now().toString(36)}-${candidates[0]}`,
      source: mode === 2 ? "population" : "karma",
      name: name.name,
      ticker: name.ticker,
      description: mode === 2 ? "Founded by the corporations of one empire." : "Brought together by a common enemy.",
      url: "",
      logo: "",
      founderCorporationID: candidates[0],
      memberCorporationIDs: candidates.slice(1, MAX_CORPS_PER_ALLIANCE),
      allianceID: 0,
      status: "founding",
      note: "",
      createdAt: new Date().toISOString(),
    });
    info(`${name.name} [${name.ticker}] planned for corporations ${candidates.join(", ")}.`);
  }
}

function hasSkill(characterID, typeID, level) {
  try {
    const map = deps.skills().getCharacterSkillMap(characterID);
    const record = map && (map.get ? map.get(typeID) : map[typeID]);
    return (Number(record && (record.trainedSkillLevel ?? record.skillLevel)) || 0) >= level;
  } catch {
    return false;
  }
}

async function fundFounder(ceoID, design) {
  const balance = Number(deps.wallet().getCharacterWallet(ceoID)?.balance) || 0;
  const shortfall = ALLIANCE_FOUNDING_COST + 1_000_000 - balance;
  if (shortfall <= 0) return true;
  const result = await deps.wallet().adjustCharacterBalanceAsync(ceoID, Math.ceil(shortfall),
    { description: "Playerbot alliance founding fee (operator grant)", ownerID2: ceoID },
    { source: "playerbot-alliance-founding", idempotencyKey: `playerbots.alliance-founding:${design.id}` });
  return Boolean(result && result.success);
}

function writeLogo(design) {
  if (!design.logo || design.logoAppliedTo === design.allianceID) return;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(design.logo);
  if (!match) return;
  const result = deps.images().storeAllianceLogo(design.allianceID, Buffer.from(match[1], "base64"));
  if (result && result.success !== false) design.logoAppliedTo = design.allianceID;
}

async function found(design, corps) {
  const founder = corps.get(design.founderCorporationID);
  if (!founder || !founder.ceo) { design.note = "The founding corporation needs a bot CEO."; return; }
  if (founder.allianceID) {
    design.allianceID = founder.allianceID;
    design.status = "recruiting";
    return;
  }
  if (deps.founding().getPendingAllianceFounding(founder.corporationID)) { design.note = "Founding is being settled."; return; }
  const ceoID = positive(founder.ceo.characterID);
  if (!hasSkill(ceoID, EMPIRE_CONTROL, 5)) deps.skills().grantCharacterSkillLevels(ceoID, [{ typeID: EMPIRE_CONTROL, level: 5 }]);
  if (!await fundFounder(ceoID, design)) { design.note = "Could not cover the founding fee."; return; }
  try {
    const session = deps.space().getActorSession(founder.ceo);
    await deps.corpRegistry().Handle_CreateAlliance([design.name, design.ticker, design.description || "", design.url || ""], session);
    design.note = "Founding requested.";
    info(`${founder.ceo.characterName} is founding ${design.name} [${design.ticker}].`);
  } catch (error) {
    design.note = `Founding refused: ${String(error && (error.message || error)).slice(0, 160)}`;
    if (/TAKEN/.test(design.note) && design.source !== "dashboard") {
      const next = nextSciFiName();
      if (next) Object.assign(design, next.name ? { name: next.name, ticker: next.ticker } : {});
      else design.status = "done-failed";
    }
  }
}

async function recruit(design, corps) {
  const founder = corps.get(design.founderCorporationID);
  writeLogo(design);
  let missing = 0;
  for (const corporationID of design.memberCorporationIDs) {
    const member = corps.get(corporationID);
    if (!member || !member.ceo) continue;
    if (member.allianceID === design.allianceID) continue;
    if (member.allianceID) continue; // already in another alliance
    missing += 1;
    try {
      const application = deps.applications().getAllianceApplication(design.allianceID, corporationID);
      if (!application) {
        deps.corpRegistry().Handle_ApplyToJoinAlliance([design.allianceID, `${design.name} welcomes its allies.`], deps.space().getActorSession(member.ceo));
      }
      const current = deps.applications().getAllianceApplication(design.allianceID, corporationID);
      if (current && Number(current.state) === 1 && founder && founder.ceo) {
        deps.allianceRegistry().Handle_UpdateApplication([corporationID, "Accepted.", APPLICATION_ACCEPTED], deps.space().getActorSession(founder.ceo));
      }
    } catch (error) {
      design.note = `Application for ${corporationID}: ${String(error && (error.message || error)).slice(0, 140)}`;
    }
  }
  design.status = missing ? "recruiting" : "formed";
}

async function maintain(bots = [], options = {}) {
  const now = Number(options.now) || Date.now();
  if (running || (!options.force && now - lastPassAtMs < PASS_MS)) return { ran: false };
  running = true;
  lastPassAtMs = now;
  try {
    const corps = botCorporations(Array.isArray(bots) ? bots : []);
    planAutomatic(corps);
    for (const design of load().designs) {
      if (["done-failed", "formed"].includes(design.status) && design.logoAppliedTo === design.allianceID) continue;
      const founder = corps.get(design.founderCorporationID);
      if (!design.allianceID && founder && founder.allianceID) design.allianceID = founder.allianceID;
      if (!design.allianceID) await found(design, corps);
      if (design.allianceID) await recruit(design, corps);
    }
    save();
    return { ran: true, designs: load().designs.length };
  } catch (error) {
    warn(error.stack || error.message);
    return { ran: false, error: error.message };
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- dashboard

function describeCorporation(corporationID) {
  const record = corporation(corporationID) || {};
  return {
    corporationID,
    name: String(record.corporationName || `Corporation ${corporationID}`),
    ticker: String(record.tickerName || record.ticker || ""),
    allianceID: positive(record.allianceID),
  };
}

function getOverview() {
  let bots = [];
  try { bots = deps.playerBots().listBots(); } catch { bots = []; }
  const corps = botCorporations(bots);
  return {
    mode: allianceMode(),
    designs: load().designs.map((design) => ({
      ...design,
      founder: describeCorporation(design.founderCorporationID),
      members: design.memberCorporationIDs.map(describeCorporation),
    })),
    corporations: [...corps.values()].map((entry) => describeCorporation(entry.corporationID))
      .sort((left, right) => left.name.localeCompare(right.name)),
    suggestedNames: SCI_FI_ALLIANCES.filter(([name]) => !load().designs.some((design) => design.name === name))
      .slice(0, 12).map(([name, ticker]) => ({ name, ticker })),
  };
}

function getLogo(id) {
  const design = load().designs.find((entry) => entry.id === String(id));
  return design && design.logo ? design.logo : "";
}

// Dashboard: create, edit or delete an alliance design.
function runCommand(body = {}) {
  const action = String(body.action || "").toLowerCase();
  const data = load();
  if (action === "delete") {
    const index = data.designs.findIndex((design) => design.id === String(body.id));
    if (index < 0) return { success: false, message: "No such alliance plan." };
    if (data.designs[index].allianceID) return { success: false, message: "That alliance exists in game; leave it in game instead." };
    data.designs.splice(index, 1);
    save();
    return { success: true, message: "Alliance plan removed." };
  }
  if (!["create", "update"].includes(action)) return { success: false, message: "Action must be create, update or delete." };
  const name = String(body.name || "").trim().slice(0, 50);
  const ticker = String(body.ticker || "").trim().slice(0, 5);
  const founderCorporationID = positive(body.founderCorporationID);
  const memberCorporationIDs = [...new Set((Array.isArray(body.memberCorporationIDs) ? body.memberCorporationIDs : [])
    .map(positive).filter((id) => id && id !== founderCorporationID))].slice(0, MAX_CORPS_PER_ALLIANCE - 1);
  const logo = String(body.logo || "");
  if (logo && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > MAX_LOGO_BYTES * 1.4)) {
    return { success: false, message: "The logo must be a PNG under 300 KB." };
  }
  const existing = action === "update" ? data.designs.find((design) => design.id === String(body.id)) : null;
  if (action === "update" && !existing) return { success: false, message: "No such alliance plan." };
  if (!existing || !existing.allianceID) {
    const formation = deps.formation();
    const checked = formation.validateAllianceFormationOptions(formation.normalizeAllianceFormationOptions({
      name, shortName: ticker, description: String(body.description || ""), url: "",
    }));
    if (checked && checked.success === false) return { success: false, message: `The name or ticker is not allowed (${checked.errorMsg}).` };
    if (nameTaken(name, ticker)) return { success: false, message: "That alliance name or ticker is already taken in game." };
    if (!founderCorporationID) return { success: false, message: "Choose the corporation that founds the alliance." };
  }
  const clash = data.designs.find((design) => design !== existing &&
    (design.name.toLowerCase() === name.toLowerCase() || design.founderCorporationID === founderCorporationID));
  if (clash) return { success: false, message: "Another plan already uses that name or founder." };
  const design = existing || {
    id: `dash-${Date.now().toString(36)}`, source: "dashboard", allianceID: 0, status: "founding", note: "", createdAt: new Date().toISOString(),
  };
  Object.assign(design, {
    name: existing && existing.allianceID ? existing.name : name,
    ticker: existing && existing.allianceID ? existing.ticker : ticker,
    description: String(body.description || "").slice(0, 1000),
    url: "",
    founderCorporationID: existing && existing.allianceID ? existing.founderCorporationID : founderCorporationID,
    memberCorporationIDs,
    ...(logo ? { logo, logoAppliedTo: 0 } : {}),
    status: design.allianceID ? "recruiting" : "founding",
  });
  if (!existing) data.designs.push(design);
  save();
  lastPassAtMs = 0; // act on it at the next director pass
  return { success: true, id: design.id, message: existing ? "Alliance plan updated." : `${name} will be founded at the next director pass.` };
}

module.exports = {
  SCI_FI_ALLIANCES,
  nextSciFiName,
  getLogo,
  getOverview,
  maintain,
  runCommand,
  _testing: {
    deps,
    karmaCoalitions,
    populationGroups,
    planAutomatic,
    reset() { state = null; lastPassAtMs = 0; running = false; },
  },
};
