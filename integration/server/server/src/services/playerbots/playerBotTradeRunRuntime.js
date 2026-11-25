"use strict";

// Trade runs: what a market importer does. A trader flying a hauler buys the
// modules, drones and charges bot pilots fit to their ships at the seed
// market, hauls them to its own trade hub and lists them there, so pilots
// upgrading at that hub find stock without flying to Jita. Bots never list in
// Jita, and a Jita purchase is refused while the item is sold anywhere else
// in the region (playerBotTradeRuntime.buy), so those items are skipped.
//
// Stages: to-source -> buy -> load -> to-market -> list -> done.
// A trader in a Freighter or Jump Freighter takes an escort fleet along
// (playerBotFleetCommandRuntime.js).

const FITS_TO_STOCK = 10; // the hub holds enough of each item for ten fits
const RESTOCK_SHARE = 0.5; // restock once the hub is below half of that
const MAX_TYPES_PER_RUN = 15;
const SPEND_SHARE = 0.25; // of the trader's wallet per run
const MAX_SPEND_ISK = 2_000_000_000;
const MIN_SPEND_ISK = 1_000_000;
const MARKUP = 1.15; // listed at the seed price plus 15%
const MAX_PRICE_OVER_PLAN = 1.5; // skip an item whose price jumped since planning
const STEP_DELAY_MS = 2_000;
const LISTING_DAYS = 90;

function positive(value) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function lazy(path) {
  let cached;
  return () => (cached ||= require(path));
}

const deps = {
  economy: lazy("./playerBotEconomyRuntime"),
  operations: lazy("./playerBotOperationRuntime"),
  trade: lazy("./playerBotTradeRuntime"),
  inventory: lazy("./playerBotInventoryRuntime"),
  types: lazy("../inventory/itemTypeRegistry"),
  wallet: lazy("../account/walletState"),
};

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function balanceOf(bot) {
  try {
    return Number(deps.wallet().getCharacterWallet(bot.characterID)?.balance) || 0;
  } catch {
    return 0;
  }
}

// What the trader's hub is short of: { hubStationID, sourceStationID,
// maxSpend, items: [{ typeID, quantity, referencePrice }] }, or null.
function planTradeRun(bot) {
  const economy = deps.economy();
  const hubStationID = positive(economy.getHubStationIDForBot(bot));
  if (!hubStationID || economy.isJitaStation(hubStationID)) return null;
  const maxSpend = Math.min(MAX_SPEND_ISK, Math.floor(balanceOf(bot) * SPEND_SHARE));
  if (maxSpend < MIN_SPEND_ISK) return null;
  const items = [];
  for (const { typeID, perFit } of deps.operations().listShipLadderItemDemand()) {
    const target = Math.max(1, Number(perFit) || 1) * FITS_TO_STOCK;
    const offers = economy.listSellOffers(typeID) || [];
    const hubStock = offers.filter((offer) => positive(offer.stationID) === hubStationID)
      .reduce((total, offer) => total + (Number(offer.quantity) || 0), 0);
    if (hubStock >= target * RESTOCK_SHARE) continue;
    const seed = offers.filter((offer) => economy.isJitaStation(positive(offer.stationID)) && Number(offer.price) > 0)
      .sort((left, right) => Number(left.price) - Number(right.price))[0];
    if (!seed) continue;
    items.push({ typeID: positive(typeID), quantity: target - hubStock, referencePrice: Number(seed.price) });
    if (items.length >= MAX_TYPES_PER_RUN) break;
  }
  if (!items.length) return null;
  const sourceStationID = positive(economy.findBestJitaSeedStation(items.map(({ typeID, quantity }) => ({ typeID, quantity })))) ||
    positive(economy.JITA_BUY_STATION_ID);
  if (!sourceStationID) return null;
  return { hubStationID, sourceStationID, maxSpend, items };
}

function describeType(typeID) {
  try {
    const type = deps.types().resolveItemByTypeID(typeID);
    return String(type && type.name || `type ${typeID}`);
  } catch {
    return `type ${typeID}`;
  }
}

function unitVolume(typeID) {
  try {
    return Math.max(0.01, Number(deps.types().resolveItemByTypeID(typeID)?.volume) || 0.01);
  } catch {
    return 0.01;
  }
}

function nextItem(operation) {
  return (operation.items || []).find((item) => !item.done) || null;
}

// One purchase per step, so a long shopping list never holds the tick.
async function buyNext(operation, bot, kit) {
  const item = nextItem(operation);
  if (!item) return false;
  const trade = deps.trade();
  const inventory = deps.inventory();
  const remainingSpend = Number(operation.maxSpend) - Number(operation.spent || 0);
  const capacity = inventory.getCargoCapacity(bot);
  const freeVolume = Math.max(0, Number(capacity.capacity || 0) - Number(operation.volume || 0));
  const volume = unitVolume(item.typeID);
  const wanted = Math.min(Number(item.quantity) - Number(item.bought || 0), Math.floor(freeVolume / volume));
  if (wanted <= 0) {
    item.done = true;
    item.note = freeVolume < volume ? "hold full" : "bought";
    return true;
  }
  const quote = await trade.readQuote(bot.characterName, item.typeID);
  const ask = quote && quote.success ? quote.bestAsk : null;
  if (!ask || Number(ask.price) > Number(item.referencePrice) * MAX_PRICE_OVER_PLAN) {
    item.done = true;
    item.note = ask ? "price jumped" : "no stock";
    return true;
  }
  const affordable = Math.floor((remainingSpend + 0.0001) / Number(ask.price));
  const quantity = Math.min(wanted, Number(ask.quantity) || 0, affordable);
  if (quantity <= 0) {
    item.done = true;
    item.note = affordable <= 0 ? "budget spent" : "no stock";
    return true;
  }
  const result = await trade.buy(bot.characterName, item.typeID, quantity, Number(ask.price));
  if (!result || !result.success) {
    if (result && result.outcomeUnknown) {
      kit.block(operation, "review", result.message);
      return "blocked";
    }
    // Sold elsewhere in the region (Jita is the fallback only) or refused.
    item.done = true;
    item.note = result && result.sourceAvailable ? "sold elsewhere in the region" : String(result && result.message || "refused").slice(0, 120);
    return true;
  }
  const bought = Number(result.bought) || 0;
  item.bought = Number(item.bought || 0) + bought;
  operation.spent = round(Number(operation.spent || 0) + (Number(result.spent) || 0));
  operation.volume = Number(operation.volume || 0) + bought * volume;
  if (bought <= 0 || item.bought >= item.quantity) item.done = true;
  if (bought > 0) kit.record(operation, `Bought ${bought} ${describeType(item.typeID)} for ${(Number(result.spent) || 0).toFixed(2)} ISK.`);
  return true;
}

async function advance(operation, bot, kit) {
  const inventory = deps.inventory();
  if (operation.stage === "to-source") {
    const step = await kit.travelToStation(operation, bot, operation.sourceStationID);
    if (step) return step;
    operation.stage = "buy";
    kit.record(operation, `At the market in ${operation.sourceStationID}: buying ${operation.items.length} kind(s) of goods for the hub.`);
    kit.save(operation);
  }
  if (operation.stage === "buy") {
    const progressed = await buyNext(operation, bot, kit);
    if (progressed === "blocked") return undefined;
    kit.save(operation);
    if (nextItem(operation)) return { delayMs: STEP_DELAY_MS };
    if (!(operation.items || []).some((item) => Number(item.bought) > 0)) {
      return kit.finish(operation, "Trade run: nothing worth hauling could be bought; the run is called off.");
    }
    operation.stage = "load";
    kit.save(operation);
  }
  if (operation.stage === "load") {
    for (const item of operation.items) {
      if (!(Number(item.bought) > 0)) continue;
      for (const stack of inventory.listHangar(bot, operation.sourceStationID, item.typeID)) {
        const loaded = inventory.loadToCargo(bot, stack.itemID);
        if (!loaded || !loaded.success) break;
      }
    }
    operation.stage = "to-market";
    kit.record(operation, `Loaded ${Math.round(Number(operation.volume || 0)).toLocaleString("en-US")} m³ of goods; hauling to the hub ${operation.hubStationID}.`);
    kit.save(operation);
    return { delayMs: STEP_DELAY_MS };
  }
  if (operation.stage === "to-market") {
    const step = await kit.travelToStation(operation, bot, operation.hubStationID);
    if (step) return step;
    inventory.unloadCargo(bot);
    operation.stage = "list";
    kit.save(operation);
  }
  if (operation.stage === "list") {
    const trade = deps.trade();
    let listed = 0;
    let value = 0;
    for (const item of operation.items) {
      if (!(Number(item.bought) > 0)) continue;
      const price = round(Number(item.referencePrice) * MARKUP);
      for (const stack of inventory.listHangar(bot, operation.hubStationID, item.typeID)) {
        const units = inventory.unitsOf(stack);
        if (units <= 0) continue;
        const result = await trade.listSellOrder(bot.characterName, stack.itemID, units, price, LISTING_DAYS);
        if (!result || !result.success) {
          kit.record(operation, `Could not list ${describeType(item.typeID)}: ${String(result && result.message || "refused").slice(0, 120)}`);
          continue;
        }
        listed += Number(result.listed || 0) + Number(result.sold || 0);
        value += units * price;
      }
    }
    operation.unitsListed = listed;
    return kit.finish(operation, `Trade run done: ${listed} units listed at ${operation.hubStationID} (worth about ${round(value).toFixed(2)} ISK; cost ${Number(operation.spent || 0).toFixed(2)} ISK).`);
  }
  return kit.block(operation, "blocked", `Unknown trade run stage ${operation.stage}.`);
}

module.exports = {
  FITS_TO_STOCK,
  MARKUP,
  advance,
  planTradeRun,
  _testing: { deps, buyNext },
};
