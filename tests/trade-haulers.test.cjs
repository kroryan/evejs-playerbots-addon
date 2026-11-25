"use strict";

// Traders: the hauler ladder up to the Jump Freighter, and the trade runs
// that bring the fittings bot pilots buy from the seed market to the hub.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const DIR = path.resolve(__dirname, "../integration/server/server/src/services/playerbots");
const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function extractFunction(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing function ${name}`);
  return source.slice(match.index, source.indexOf("\n}", match.index) + 2);
}

function extractBlock(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  return source.slice(from, source.indexOf(end, from) + end.length);
}

function ladder(characters) {
  const source = fs.readFileSync(path.join(DIR, "playerBotOperationRuntime.js"), "utf8");
  const code = [
    extractBlock(source, "const SHIP_LADDER = Object.freeze({", "\n});\n"),
    extractBlock(source, "const TRADE_RACES", ";\n"),
    "const resolvedLadderRungs = new WeakMap();",
    ...["normalizePositiveInteger", "resolveLadderTypeID", "resolveShipLadderRung", "botRaceID", "roleLadder", "nextShipUpgrade"]
      .map((name) => extractFunction(source, name)),
    "this.api = { nextShipUpgrade, roleLadder };",
  ].join("\n");
  const context = {
    Map, Set, WeakMap, Number, Object, Array, Math, String,
    getCharacterRecord: (id) => characters.get(Number(id)) || null,
    canUseRung: () => true,
    hasSkills: () => true,
    selectBootstrapRung: () => null,
    require: (id) => {
      if (id === "../inventory/itemStore") return { listCharacterItems: () => [], ITEM_FLAGS: { CARGO_HOLD: 5, DRONE_BAY: 87 } };
      if (id === "../fitting/liveFittingState") return { isEffectivelyOnlineModule: () => true };
      throw new Error(`Unexpected dependency: ${id}`);
    },
    getInventory: () => ({ unitsOf: () => 1 }),
  };
  vm.runInNewContext(code, context);
  return context.api;
}

test("traders climb their own race's hauler line to the Jump Freighter", () => {
  const characters = new Map([
    [1, { raceID: 2, shipTypeID: 606 }], // Minmatar in a rookie ship
    [2, { raceID: 2, shipTypeID: 12747 }], // Mastodon
    [3, { raceID: 2, shipTypeID: 20189 }], // Fenrir
    [4, { raceID: 2, shipTypeID: 28846 }], // Nomad: the end of the line
    [5, { raceID: 8, shipTypeID: 20185 }], // Gallente pilot in a Caldari Charon
    [6, { raceID: 135, shipTypeID: 606 }], // a race without haulers flies Caldari
  ]);
  const api = ladder(characters);
  const next = (id) => api.nextShipUpgrade({ characterID: id }, "trade");
  assert.deepEqual(plain(api.roleLadder("trade", { characterID: 1 }).map((rung) => rung.hullTypeID)), [652, 12747, 20189, 28846]);
  assert.equal(next(1).hullTypeID, 652, "first a Mammoth");
  assert.equal(next(2).hullTypeID, 20189, "a Deep Space Transport pilot moves on to the Fenrir");
  assert.equal(next(3).hullTypeID, 28846, "a freighter pilot moves on to the Nomad");
  assert.equal(next(4), null, "nothing tops the Jump Freighter");
  assert.equal(next(5).hullTypeID, 28848, "from another race's freighter, its own race's Jump Freighter");
  assert.equal(next(6).hullTypeID, 649, "Caldari line by default");
  assert.ok(next(3).minBalance >= 12_000_000_000, "a Jump Freighter needs the ISK for it");
});

function tradeRun(overrides = {}) {
  const calls = [];
  const HUB = 60011866;
  const JITA = 60003760;
  const offers = {
    // Hobgoblin I: none at the hub.
    2454: [{ stationID: JITA, price: 5_000, quantity: 10_000 }],
    // Damage Control I: the hub is stocked.
    2046: [{ stationID: JITA, price: 20_000, quantity: 10_000 }, { stationID: HUB, price: 23_000, quantity: 50 }],
    // Miner I: not sold in Jita at all.
    483: [],
  };
  const hangar = new Map();
  const runtime = require(path.join(DIR, "playerBotTradeRunRuntime.js"));
  const { deps } = runtime._testing;
  deps.economy = () => ({
    getHubStationIDForBot: () => HUB,
    isJitaStation: (id) => Number(id) === JITA,
    listSellOffers: (typeID) => offers[typeID] || [],
    findBestJitaSeedStation: () => JITA,
    JITA_BUY_STATION_ID: JITA,
  });
  deps.operations = () => ({
    listShipLadderItemDemand: () => [{ typeID: 2454, perFit: 2 }, { typeID: 2046, perFit: 1 }, { typeID: 483, perFit: 2 }],
  });
  deps.wallet = () => ({ getCharacterWallet: () => ({ balance: overrides.balance ?? 1_000_000_000 }) });
  deps.types = () => ({ resolveItemByTypeID: (id) => ({ typeID: id, name: `type ${id}`, volume: 5 }) });
  deps.trade = () => ({
    readQuote: async (name, typeID) => ({ success: true, bestAsk: (offers[typeID] || [])[0] || null }),
    buy: async (name, typeID, quantity, price) => {
      calls.push(["buy", typeID, quantity, price]);
      if (overrides.soldElsewhere) return { success: false, sourceAvailable: true, sourceStationID: 60004588 };
      hangar.set(typeID, (hangar.get(typeID) || 0) + quantity);
      return { success: true, bought: quantity, spent: quantity * price };
    },
    listSellOrder: async (name, itemID, units, price) => { calls.push(["list", itemID, units, price]); return { success: true, listed: units, sold: 0 }; },
  });
  deps.inventory = () => ({
    getCargoCapacity: () => ({ capacity: overrides.cargo ?? 435_000 }),
    listHangar: (bot, stationID, typeID) => (hangar.get(typeID) ? [{ itemID: typeID * 10, typeID, stacksize: hangar.get(typeID) }] : []),
    loadToCargo: (bot, itemID) => { calls.push(["load", itemID]); return { success: true }; },
    unloadCargo: () => calls.push(["unload"]),
    unitsOf: (item) => item.stacksize,
  });
  const kit = {
    travelToStation: async (operation, bot, stationID) => (overrides.travelled ? null : { delayMs: 5_000, stationID }),
    record: (operation, message) => { operation.lastAction = message; },
    save() {},
    block: (operation, status, reason) => { operation.status = status; operation.lastError = reason; return { blocked: true }; },
    finish: (operation, message) => { operation.status = "completed"; operation.lastAction = message; return { done: true }; },
  };
  return { runtime, calls, kit, HUB, JITA };
}

test("a trade run plans what the hub lacks and Jita stocks, within a quarter of the wallet", () => {
  const { runtime, HUB, JITA } = tradeRun();
  const plan = plain(runtime.planTradeRun({ characterID: 7 }));
  assert.deepEqual(plan, {
    hubStationID: HUB,
    sourceStationID: JITA,
    maxSpend: 250_000_000,
    items: [{ typeID: 2454, quantity: 20, referencePrice: 5_000 }],
  });
  assert.equal(tradeRun({ balance: 1_000 }).runtime.planTradeRun({ characterID: 7 }), null, "no money, no run");
});

test("a trade run buys, hauls and lists at the seed price plus 15%", async () => {
  const { runtime, calls, kit, HUB, JITA } = tradeRun({ travelled: true });
  const operation = { stage: "to-source", sourceStationID: JITA, hubStationID: HUB, maxSpend: 250_000_000, spent: 0, volume: 0,
    items: [{ typeID: 2454, quantity: 20, referencePrice: 5_000, bought: 0, done: false }] };
  const bot = { characterID: 7, characterName: "Trader" };
  for (let step = 0; step < 6 && operation.status !== "completed"; step += 1) await runtime.advance(operation, bot, kit);
  assert.equal(operation.status, "completed");
  assert.deepEqual(calls.map((call) => call[0]), ["buy", "load", "unload", "list"]);
  assert.deepEqual(calls[0], ["buy", 2454, 20, 5_000]);
  assert.deepEqual(calls[3], ["list", 24540, 20, 5_750]);
  assert.equal(operation.spent, 100_000);
  assert.match(operation.lastAction, /20 units listed/);
});

test("a trade run skips items sold elsewhere in the region and calls off an empty run", async () => {
  const { runtime, calls, kit, HUB, JITA } = tradeRun({ travelled: true, soldElsewhere: true });
  const operation = { stage: "buy", sourceStationID: JITA, hubStationID: HUB, maxSpend: 250_000_000, spent: 0, volume: 0,
    items: [{ typeID: 2454, quantity: 20, referencePrice: 5_000, bought: 0, done: false }] };
  for (let step = 0; step < 4 && operation.status !== "completed"; step += 1) {
    await runtime.advance(operation, { characterID: 7, characterName: "Trader" }, kit);
  }
  assert.equal(operation.items[0].note, "sold elsewhere in the region");
  assert.equal(operation.status, "completed");
  assert.match(operation.lastAction, /called off/);
  assert.equal(calls.filter((call) => call[0] === "list").length, 0);
});

test("the trade guard lets one capital hauler hull cost up to 20B, and nothing else", () => {
  const source = fs.readFileSync(path.join(DIR, "playerBotTradeRuntime.js"), "utf8");
  assert.match(source, /MAX_CAPITAL_HAULER_PRICE_ISK = 20_000_000_000/);
  const hulls = require(path.join(DIR, "playerBotTransportHulls.js"));
  assert.equal(hulls.isSuperHauler(20185), true, "Charon");
  assert.equal(hulls.isSuperHauler(28850), true, "Ark");
  assert.equal(hulls.isSuperHauler(12731), false, "Bustard is a transport, not a capital hauler");
});

test("the director upgrades a trader's hauler, then sends it on trade runs, and never back to mining", () => {
  const source = fs.readFileSync(path.join(DIR, "playerBotDirectorRuntime.js"), "utf8");
  let plan = { items: [{ typeID: 2454 }] };
  const context = {
    Date, Number,
    TRADE_RUN_COOLDOWN_MS: 30 * 60 * 1000,
    upgradeCoolingDown: () => false,
    hubStationFor: () => 60011866,
    require: (id) => {
      assert.equal(id, "./playerBotTradeRunRuntime");
      return { planTradeRun: () => plan };
    },
  };
  vm.runInNewContext(`${extractFunction(source, "chooseTradeAssignment")}\nthis.choose = chooseTradeAssignment;`, context);
  const operations = (fields) => ({ nextShipUpgrade: () => null, getOperation: () => null, hasRoleShipFit: () => true, findUpgradeMarketStation: () => 60003760, ...fields });
  const bot = { characterID: 7, specialty: "trade" };
  const upgrade = plain(context.choose(bot, {}, 3e9, operations({ nextShipUpgrade: () => ({ minBalance: 2_500_000_000 }) })));
  assert.deepEqual(upgrade, { kind: "upgrade", role: "trade", marketStationID: 60003760 });
  assert.equal(context.choose(bot, {}, 1e9, operations({ nextShipUpgrade: () => ({ minBalance: 2_500_000_000 }) })).kind, "trade-run", "not enough ISK yet: keep trading");
  assert.equal(context.choose(bot, {}, 1e9, operations({ getOperation: () => ({ kind: "trade-run", updatedAt: new Date().toISOString() }) })), null, "rests between runs");
  plan = null;
  assert.equal(context.choose(bot, {}, 1e9, operations()), null, "a hub with stock: wait docked");
  assert.equal(context.choose(bot, {}, 1e9, operations({ hasRoleShipFit: () => false })), undefined, "no hauler yet: ordinary work");
});
