"use strict";

// Corporation hangars: bots get roles for divisions 1-5 in any corporation,
// bot-run corporations name the divisions and rent the office, and deposits
// go to the division for the kind of work.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const DIR = path.resolve(__dirname, "../integration/server/server/src/services/playerbots");
const BOT_CORP = 98000001;
const PLAYER_CORP = 98000050;
const STATION = 60003760;

function world() {
  const hangars = require(path.join(DIR, "playerBotCorpHangarRuntime.js"));
  const { deps } = hangars._testing;
  hangars._testing.reset();
  const runtimes = new Map([
    [BOT_CORP, { members: { 1: { roles: "1", rolesAtHQ: "0", rolesAtBase: "0", rolesAtOther: "0" }, 2: { roles: "0" } }, divisionNames: { 1: "Division 1", 6: "Spare" }, offices: {} }],
    [PLAYER_CORP, { members: { 3: { roles: "0" }, 900: { roles: "0" } }, divisionNames: {}, offices: {} }],
  ]);
  const calls = [];
  Object.assign(deps, {
    runtime: () => ({
      getCorporationMember: (corp, id) => JSON.parse(JSON.stringify(runtimes.get(corp).members[String(id)] || null)),
      updateCorporationRuntime: (corp, updater) => updater(runtimes.get(corp)),
      syncMemberStateToCharacterRecord: () => {},
      getCorporationDivisionNames: (corp) => ({ ...runtimes.get(corp).divisionNames }),
      getCorporationOffices: (corp) => Object.values(runtimes.get(corp).offices),
    }),
    corporations: () => ({ getCorporationRecord: (id) => ({ [BOT_CORP]: { ceoID: 1 }, [PLAYER_CORP]: { ceoID: 900 } })[id] || null }),
    playerBots: () => ({ hasBotProfile: (id) => Number(id) < 100 }),
    space: () => ({ getActorSession: (bot) => ({ characterID: bot.characterID, stationid: STATION }) }),
    offices: () => ({ Handle_RentOffice: async (args, session) => {
      calls.push(["rent", session.characterID]);
      runtimes.get(BOT_CORP).offices.o1 = { officeID: 70001, stationID: STATION };
    } }),
    logger: () => ({ info() {}, warn() {} }),
  });
  return { hangars, runtimes, calls };
}

const mask = (value) => BigInt(String(value || "0"));

test("bots get hangar roles 1-5 in bot and player corporations; people are left alone", () => {
  const { hangars, runtimes } = world();
  assert.equal(hangars.grantHangarRoles(BOT_CORP, 2), true);
  assert.equal(hangars.grantHangarRoles(PLAYER_CORP, 3), true, "a bot in a player corporation too");
  assert.equal(hangars.grantHangarRoles(PLAYER_CORP, 900), false, "never a person's roles");
  for (const field of ["roles", "rolesAtHQ", "rolesAtBase", "rolesAtOther"]) {
    assert.equal(mask(runtimes.get(PLAYER_CORP).members[3][field]) & hangars.BOT_HANGAR_ROLES, hangars.BOT_HANGAR_ROLES);
  }
  assert.equal(mask(runtimes.get(BOT_CORP).members[2].roles) & 1n, 0n, "no director role is handed out");
  assert.equal(mask(runtimes.get(PLAYER_CORP).members[3].roles) & 262144n, 0n, "division 6 stays closed");
  assert.equal(hangars.grantHangarRoles(BOT_CORP, 2), false, "checked once per ten minutes");
});

test("bot corporations name divisions 1-5, keeping names already chosen; player corporations keep theirs", () => {
  const { hangars, runtimes } = world();
  runtimes.get(BOT_CORP).divisionNames[3] = "Our Factory";
  hangars.nameDivisions(BOT_CORP);
  assert.deepEqual(runtimes.get(BOT_CORP).divisionNames, { 1: "Mining", 2: "Planetary", 3: "Our Factory", 4: "Trade", 5: "Combat", 6: "Spare" });
  assert.equal(hangars.nameDivisions(PLAYER_CORP), false);
});

test("the bot CEO docked at headquarters rents the office; deposits go to the division for the work", async () => {
  const { hangars, calls } = world();
  assert.equal(await hangars.prepareDeposit({ characterID: 2 }, BOT_CORP, STATION, "mine"), null, "only the CEO rents");
  const mining = await hangars.prepareDeposit({ characterID: 1 }, BOT_CORP, STATION, "mine");
  assert.deepEqual(JSON.parse(JSON.stringify(mining)), { locationID: 70001, flagID: 115, division: 1, label: "corporation hangar 1 (Mining)" });
  const planetary = await hangars.prepareDeposit({ characterID: 2 }, BOT_CORP, STATION, "pi-collect");
  assert.equal(planetary.flagID, 116, "PI goods go to hangar 2 once the office exists");
  assert.deepEqual(calls, [["rent", 1]], "rented once");
  assert.equal(await hangars.prepareDeposit({ characterID: 3 }, PLAYER_CORP, STATION, "mine"), null, "a player corporation rents its own office");
});

test("deposits use the prepared hangar, a hand-picked division, or Deliveries when chosen", () => {
  const deposit = require(path.join(DIR, "playerBotCorpDepositRuntime.js"));
  let saved = {};
  deposit.configure({
    store: () => ({ read: () => saved, write: (value) => { saved = value; } }),
    corporations: () => ({ getCorporationOffices: () => [] }),
  });
  const prepared = { locationID: 70001, flagID: 116, label: "corporation hangar 2 (Planetary)" };
  const { describeTarget } = deposit._testing;
  assert.equal(describeTarget(BOT_CORP, STATION, prepared).flagID, 116);
  saved = { [BOT_CORP]: { enabled: true, target: "deliveries", division: 1 } };
  deposit.configure({ store: () => ({ read: () => saved, write: (value) => { saved = value; } }) });
  assert.equal(describeTarget(BOT_CORP, STATION, prepared).flagID, 116, "an old saved default of Deliveries moves to hangars");
  deposit.updateSettings(BOT_CORP, { target: "hangar", division: 6 });
  assert.equal(describeTarget(BOT_CORP, STATION, prepared).flagID, 120, "a division chosen by hand wins");
  deposit.updateSettings(BOT_CORP, { target: "deliveries", deliveriesChosen: true });
  assert.equal(describeTarget(BOT_CORP, STATION, prepared).flagID, 62, "Deliveries chosen by hand");
  deposit.reset();
});
