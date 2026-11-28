"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../integration/server/server/src/services/playerbots");
const namesModule = require(path.join(root, "playerBotNameLibraryRuntime"));
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/name-library/four-empires.json"), "utf8");

function load(file, dependencies) {
  const module = { exports: {} };
  const actualRequire = createRequire(file);
  const context = vm.createContext({ module, exports: module.exports, process, console, Date, Map, Set,
    setImmediate, Buffer, require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id.startsWith("node:")) return actualRequire(id);
      throw Error(`Unexpected dependency: ${id}`);
    } });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { api: module.exports, context };
}

function roster(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-creation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = namesModule.createNameLibrary({ file: path.join(dir, "names.json") }); names.saveText(fixture);
  const bots = {}, characters = new Map(), corporations = new Map(); let nextID = 1000;
  const authority = {
    findCorporationByFoundingOperationID: (key) => [...corporations.values()].find((c) => c.foundingOperationID === key),
    findCorporationByName: (name) => [...corporations.values()].find((c) => c.corporationName === name),
    findAllianceByExactName: () => null,
    findCorporationByTickerName: (ticker) => [...corporations.values()].find((c) => c.tickerName === ticker),
    findAllianceByShortName: () => null,
    getCorporationRecord: (id) => corporations.get(Number(id)),
    setCharacterAffiliation(id, corp) { characters.get(id).corporationID = corp; return { success: true }; },
    createCustomCorporation(id, name, options) {
      const corp = { corporationID: 2000 + corporations.size, corporationName: name, ceoID: id, creatorID: id,
        memberLimit: 300, memberCount: 1, description: `Capsuleer corporation ${name}.`, ...options };
      corporations.set(corp.corporationID, corp); characters.get(id).corporationID = corp.corporationID;
      return { success: true, data: { corporationRecord: corp } };
    },
  };
  const repository = { ensureTable() {}, read(_table, key) { return { success: true, data: key === "/" ? bots : bots[key.slice(1)] }; },
    write(_table, key, value) { bots[key.slice(1)] = value; return { success: true }; }, flushTableSync() { return { success: true }; } };
  const { api, context } = load(path.join(root, "playerBotRuntime.js"), {
    "../../gameStore/tableRepository": { createTableRepository: () => repository },
    "../character/characterState": { getCharacterRecord: (id) => characters.get(id), readSharedCharacterRecord: (id) => characters.get(id) },
    "../character/characterNameRuntime": { getValidRandomName: () => `Pilot ${nextID}`, validateCharacterName: () => 0, VALIDATION_CODE: { VALID: 0 } },
    "../corporation/corporationState": authority,
    "../corporation/corporationRuntimeState": { ensureCharacterMemberState() {}, getCorporationSessionRoleState() {},
      updateCorporationRecord(id, changes) { Object.assign(corporations.get(id), changes); return { success: true }; } },
    "./playerBotConfigurationRuntime": { getSettings: () => ({ rosterTarget: 100, rosterCeiling: 100 }) },
    "./playerBotCapacityRuntime": { getBotSystemID: () => 30000142 },
    "./playerBotOriginRuntime": { chooseOrigin: () => ({ raceID: [4, 1, 8, 2][characters.size % 4], bloodlineID: 1, schoolID: 1, stationID: 60000001 }) },
    "./playerBotNameRuntime": { generateBotName: () => `Pilot ${nextID}` },
    "./playerBotNameLibraryRuntime": { getRuntime: () => ({ chooseName: (race, type) => names.chooseName(race, type, authority) }) },
    "../character/charService": { createPlayerBotCharacter(name) {
      const id = nextID++; characters.set(id, { characterID: id, characterName: name });
      return { success: true, data: { characterID: id, characterName: name } };
    } },
    "./playerBotPortraitRuntime": { ensurePortrait() {}, queuePortrait() {} },
    "./playerBotEconomyRuntime": { hubStationForRace: () => 60000001 },
    "./playerBotProvisioningRuntime": { reconcileManagedCorporationMemberLimits() {} },
    "./playerBotCorporationEmblemRuntime": require(path.join(root, "playerBotCorporationEmblemRuntime")),
    "./playerBotSciFiCorporationNames": { chooseCorporationName: () =>
      require(path.join(root, "playerBotSciFiCorporationNames")).chooseCorporationName({ authority }),
    generateCorporationName: (specialtyID) =>
      require(path.join(root, "playerBotSciFiCorporationNames")).generateCorporationName(specialtyID, { authority }) },
  });
  return { api, context, names, authority, bots, characters, corporations };
}

test("real roster seeding retains all six specialties and founding identities while using custom names", (t) => {
  const h = roster(t);
  const first = h.api.seedRoster(30, 6); assert.equal(first.created, 6, first.error);
  assert.equal(h.corporations.size, 6);
  for (const bot of Object.values(h.bots)) {
    const corp = h.corporations.get(bot.corporationID);
    assert.equal(corp.foundingOperationID, `evejs-playerbots:${bot.specialty}`);
    assert.equal(bot.specialtyCorporationID, corp.corporationID);
    assert.equal(corp.description, h.api.SPECIALTIES.find((s) => s.id === bot.specialty).name);
    assert.ok(!corp.corporationName.startsWith("EVEJS"));
    assert.match(corp.tickerName, /^[A-Z]{2,5}$/);
  }
  const ids = [...h.corporations.keys()];
  h.names.saveText(JSON.stringify(namesModule.emptyLibrary()));
  const next = h.api.seedRoster(30, 6); assert.equal(next.created, 6, next.error);
  assert.deepEqual([...h.corporations.keys()], ids);
  assert.equal(Object.keys(h.bots).length, 12);
});

test("without library names, new corporations take famous sci-fi names and random emblems", (t) => {
  const h = roster(t);
  h.names.saveText(JSON.stringify(namesModule.emptyLibrary()));
  const scifi = require(path.join(root, "playerBotSciFiCorporationNames"));
  const emblems = require(path.join(root, "playerBotCorporationEmblemRuntime"));
  const result = h.api.seedRoster(30, 6); assert.equal(result.created, 6, result.error);
  const tickers = new Set();
  for (const corp of h.corporations.values()) {
    assert.ok(scifi.NAMES.includes(corp.corporationName), corp.corporationName);
    assert.match(corp.tickerName, /^[A-Z]{2,5}$/);
    tickers.add(corp.tickerName);
    assert.ok(emblems.SHAPES.includes(corp.shape1), `shape1 ${corp.shape1}`);
    assert.ok(emblems.COLORS.includes(corp.color1), `color1 ${corp.color1}`);
    for (const layer of [2, 3]) {
      if (corp[`shape${layer}`] === emblems.NO_SHAPE) assert.equal(corp[`color${layer}`], null);
      else assert.ok(emblems.COLORS.includes(corp[`color${layer}`]));
    }
  }
  assert.equal(tickers.size, 6);
});

test("the sci-fi names and random emblems can each be turned off", (t) => {
  const saved = { names: process.env.EVEJS_PLAYER_BOTS_SCIFI_CORPORATION_NAMES, emblems: process.env.EVEJS_PLAYER_BOTS_CORPORATION_EMBLEMS };
  t.after(() => {
    for (const [key, value] of [["EVEJS_PLAYER_BOTS_SCIFI_CORPORATION_NAMES", saved.names], ["EVEJS_PLAYER_BOTS_CORPORATION_EMBLEMS", saved.emblems]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.EVEJS_PLAYER_BOTS_SCIFI_CORPORATION_NAMES = "0";
  process.env.EVEJS_PLAYER_BOTS_CORPORATION_EMBLEMS = "0";
  const h = roster(t);
  h.names.saveText(JSON.stringify(namesModule.emptyLibrary()));
  const result = h.api.seedRoster(30, 6); assert.equal(result.created, 6, result.error);
  for (const corp of h.corporations.values()) {
    // Generated in-universe names, never the old "EVEJS <specialty>" ones.
    assert.ok(corp.corporationName && !/^evejs\b/i.test(corp.corporationName), corp.corporationName);
    assert.equal(corp.shape1, undefined);
  }
});

test("emblems use only the client's logo shapes and colours, with distinct layers", () => {
  const emblems = require(path.join(root, "playerBotCorporationEmblemRuntime"));
  assert.equal(emblems.SHAPES[0], 416);
  assert.equal(emblems.SHAPES.at(-1), 578);
  assert.deepEqual([emblems.COLORS[0], emblems.COLORS.at(-1)], [671, 685]);
  let layers = 0;
  for (let i = 0; i < 2000; i += 1) {
    const e = emblems.chooseEmblem();
    const shapes = [e.shape1, e.shape2, e.shape3].filter((shape) => shape !== emblems.NO_SHAPE);
    const colors = [e.color1, e.color2, e.color3].filter((color) => color !== null);
    assert.equal(new Set(shapes).size, shapes.length);
    assert.equal(new Set(colors).size, colors.length);
    assert.equal(shapes.length, colors.length);
    layers += shapes.length;
  }
  assert.ok(layers > 2000 * 1.5 && layers < 2000 * 2.3, `average layers ${layers / 2000}`);
  assert.deepEqual(emblems.emblemForNewCorporation({ env: { EVEJS_PLAYER_BOTS_CORPORATION_EMBLEMS: "0" } }), {});
});

test("every sci-fi name fits the client and gets its own ticker", () => {
  const scifi = require(path.join(root, "playerBotSciFiCorporationNames"));
  assert.ok(scifi.NAMES.length >= 100);
  assert.equal(new Set(scifi.NAMES.map((name) => name.toLowerCase())).size, scifi.NAMES.length);
  const corps = new Set(), tickers = new Set();
  const authority = { findCorporationByName: (name) => corps.has(name), findAllianceByExactName: () => false,
    findCorporationByTickerName: (ticker) => tickers.has(ticker), findAllianceByShortName: () => false };
  for (let i = 0; i < scifi.NAMES.length; i += 1) {
    const choice = scifi.chooseCorporationName({ authority });
    assert.ok(choice, `ran out after ${i}`);
    assert.ok(choice.name.length >= 4 && choice.name.length <= 50 && /^[A-Za-z0-9 .-]+$/.test(choice.name), choice.name);
    corps.add(choice.name); tickers.add(choice.ticker);
  }
  assert.equal(scifi.chooseCorporationName({ authority }), null);
});

test("name exhaustion fails before creating a founder character", (t) => {
  const h = roster(t), library = namesModule.emptyLibrary();
  library.amarr.corporations = ["Occupied Name"];
  h.names.saveText(JSON.stringify(library));
  h.corporations.set(999, { corporationID: 999, corporationName: "Occupied Name" });
  const result = h.api.seedRoster(30, 1);
  assert.match(result.error, /No unused corporation names/);
  assert.equal(h.characters.size, 0);
  assert.equal(Object.keys(h.bots).length, 0);
});

test("alliance plans keep existing pending identity after the configured library changes", (t) => {
  const h = roster(t), bot = { characterID: 1, corporationID: 2, specialty: "sovereignty" };
  const corp = { corporationID: 2, creatorID: 1, ceoID: 1, corporationName: "Existing Corporation" };
  let pending = null;
  const { api } = load(path.join(root, "playerBotAllianceRuntime.js"), {
    "../character/characterState": { getCharacterRecord: () => ({ corporationID: 2, raceID: 4 }) },
    "../corporation/corporationState": { getCorporationRecord: () => corp },
    "./playerBotOperationRecords": { listReadOnlyActiveOperations: () => [] },
    "./playerBotOperationRuntime": {},
    "../corporation/allianceFoundingState": { getPendingAllianceFounding: () => pending },
    "../corporation/corporationRuntimeState": { getCorporationMemberRoleMask: () => 0n },
    "../account/walletState": { getCharacterWallet: () => ({ balance: 3_000_000_000 }) },
    "../corporation/allianceFormationEligibility": { checkAllianceFormationEligibility: () => ({ success: true }) },
    "./playerBotRuntime": h.api,
    "./playerBotNameLibraryRuntime": { getRuntime: () => ({ chooseName: (race, type) => h.names.chooseName(race, type, h.authority), reportOnce() {} }) },
  });
  const plan = api.getAllianceFoundingPlan(bot);
  assert.equal(plan.name, "Hallowed Throne Concord");
  assert.equal(plan.description, "Sovereignty");
  pending = { characterID: 1, allianceOptions: { name: plan.name, shortName: plan.shortName, description: plan.description, url: "" } };
  h.names.saveText(JSON.stringify(namesModule.emptyLibrary()));
  assert.equal(api.getAllianceFoundingPlan(bot).name, plan.name);
  pending = null;
  assert.equal(api.getAllianceFoundingPlan(bot).name, "Existing Corporation Alliance");
  assert.equal(api.getAllianceFoundingPlan({ ...bot, specialty: "industry" }), null);
});

test("the unchanged director makes the same six specialty decisions when only the corporation name changes", () => {
  let corporationName = "EVEJS Industrial Union";
  const { api } = load(path.join(root, "playerBotDirectorRuntime.js"), {
    "../../gameStore/tableRepository": { createTableRepository: () => ({ ensureTable() {}, read() { return { success: true, data: {} }; } }) },
    "../character/characterState": { getCharacterRecord: () => ({ corporationID: 2000, corporationName }) },
    "../account/walletState": { getCharacterWallet: () => ({ balance: 100_000 }) },
    "./playerBotCapacityRuntime": {},
    "./playerBotEconomyRuntime": { BOT_HUB_STATION_ID: 60000001 },
    "./playerBotOperationRuntime": { nextPlanetaryLaunch: () => null, getOperation: () => null,
      // Every role's fit but a trade hauler: a trader without one still mines.
      findSellableGoodsStation: () => null, nextShipUpgrade: () => null, hasRoleShipFit: (bot, role) => role !== "trade" },
    "./playerBotMiningEscortRuntime": { findPendingMiningEscortRequest: () => null },
    "./playerBotStructureRuntime": { findStructurePackage: () => null },
    "./playerBotWarMobilizationRuntime": { getActiveWarCombatAssignment: () => null, getCombatUpgradeSupport: () => null },
    "../planet/planetRuntimeStore": { listColoniesForCharacter: () => [] },
    "./playerBotColonyRuntime": { hasColonySkill: (bot) => bot.specialty === "planetary" },
    "./playerBotIndustryCycleRuntime": { getCycle: () => null },
    "./playerBotCorpEconomyRuntime": { getCumulativeNetProfit: () => ({ reinvestableProfit: 0 }) },
    "../corporation/warRuntimeState": { hasActiveWarForCharacter: () => true },
    "./playerBotAllianceRuntime": { getAllianceFoundingPlan: () => null },
    "./playerBotSovereigntyRuntime": { findSovereigntyObjective: () => ({ systemID: 42 }) },
    "./playerBotPiWorkPolicy": require(path.join(root, "playerBotPiWorkPolicy")),
  });
  for (const [specialty, expected] of [["trade", "mine"], ["industry", "industry"], ["planetary", "colony"],
    ["security", "combat"], ["piracy", "combat"], ["sovereignty", "sovereignty"]]) {
    const bot = { characterID: 1000, corporationID: 2000, specialtyCorporationID: 2000, specialty };
    corporationName = `EVEJS ${specialty}`;
    const before = JSON.stringify(api._testing.chooseAssignment(bot));
    corporationName = "Wrecker's Banner Cooperative";
    const after = JSON.stringify(api._testing.chooseAssignment(bot));
    assert.equal(after, before, specialty);
    assert.equal(JSON.parse(after).kind, expected);
  }
});
