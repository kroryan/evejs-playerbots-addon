"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const names = require("../integration/server/server/src/services/playerbots/playerBotSciFiCorporationNames");

function authority(taken = new Set()) {
  return {
    findCorporationByName: (name) => taken.has(name),
    findAllianceByExactName: () => false,
    findCorporationByTickerName: () => false,
    findAllianceByShortName: () => false,
  };
}

test("generated names fit the specialty and never use the old EVEJS prefix", () => {
  for (const specialty of ["trade", "industry", "planetary", "security", "piracy", "sovereignty", ""]) {
    const chosen = names.generateCorporationName(specialty, { authority: authority() });
    assert.ok(chosen && chosen.name && /^[A-Z]{2,5}$/.test(chosen.ticker));
    assert.equal(names.isLegacyName(chosen.name), false);
  }
  const trade = names.generateCorporationName("trade", { authority: authority(), random: () => 0 });
  assert.match(trade.name, /Freight Consortium|Trading House|Exchange|Merchant League|Commerce Guild/);
});

test("taken names are skipped and legacy names are recognised", () => {
  const first = names.generateCorporationName("piracy", { authority: authority(), random: () => 0 });
  const second = names.generateCorporationName("piracy", { authority: authority(new Set([first.name])), random: () => 0 });
  assert.notEqual(second.name, first.name);
  assert.equal(names.isLegacyName("EVEJS Freebooters 3"), true);
  assert.equal(names.isLegacyName("Evejs Security Fleet"), true);
  assert.equal(names.isLegacyName("Weyland-Yutani"), false);
});
