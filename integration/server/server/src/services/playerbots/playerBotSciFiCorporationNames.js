"use strict";

// Default names for new playerbot corporations: famous companies from science
// fiction films, television, books and games. A new bot corporation takes a
// random unused name from this list, unless the dashboard's name library has
// corporation names for the pilot's empire (those come first). When every name
// here is in use, or the list is turned off with
// EVEJS_PLAYER_BOTS_SCIFI_CORPORATION_NAMES=0, generateCorporationName() makes
// an in-universe name from word lists that fit the corporation's specialty.

const NAMES = Object.freeze([
  // Film
  "Weyland-Yutani", "Tyrell Corporation", "Wallace Corporation", "Cyberdyne Systems",
  "Omni Consumer Products", "Security Concepts", "Buy n Large", "InGen", "Biosyn",
  "Soylent Corporation", "Rekall", "Zorg Industries", "Hyperdyne Systems",
  "Yoyodyne Propulsion Systems", "Armadyne", "Lunar Industries", "Multi-National United",
  "Resources Development Administration", "Wilford Industries", "Metacortex",
  "Delos Incorporated", "Tetravaal", "Pharmakom", "Con-Am", "Drax Industries",
  "Cobolt", "Lacuna Inc",
  "Spiga Biotech", "Psychasec", "Lumon Industries", "Dyad Institute",
  // Television
  "Massive Dynamic", "Blue Sun Corporation", "Momcorp", "Planet Express",
  "Spacely Space Sprockets", "Cogswell Cogs", "Global Dynamics", "Veridian Dynamics",
  "Mao-Kwikowski Mercantile", "Protogen", "Pinkwater Security", "Ferrous Corporation",
  "Piron", "Utopia Planitia Fleet Yards",
  // Books
  "Sirius Cybernetics Corporation", "Megadodo Publications", "Tessier-Ashpool",
  "Hosaka", "Ono-Sendai", "Maas Biolabs", "Sense Net", "CHOAM", "Spacing Guild",
  "Ixian Confederacy", "Encyclopedia Galactica", "US Robots and Mechanical Men",
  // Star Wars
  "Kuat Drive Yards", "Incom Corporation", "Sienar Fleet Systems",
  "Corellian Engineering Corporation", "Cybot Galactica", "Czerka Corporation",
  "BlasTech Industries", "Merr-Sonn Munitions", "Arakyd Industries",
  "SoroSuub Corporation", "Baktoid Armor Workshop", "Koensayr Manufacturing",
  "Mon Calamari Shipyards", "Tagge Company", "Industrial Automaton", "Haor Chall Engineering",
  // Games
  "Aperture Science", "Black Mesa", "Umbrella Corporation", "Abstergo Industries",
  "Shinra Electric Power Company", "Vault-Tec", "RobCo Industries", "Poseidon Energy",
  "Hyperion", "Dahl", "Maliwan", "Jakobs", "Tediore", "Torgue", "Vladof", "Atlas Corporation",
  "Arasaka", "Militech", "Kang Tao", "Biotechnica", "Trauma Team International",
  "Sarif Industries", "Tai Yong Medical", "Versalife", "TriOptimum Corporation",
  "Union Aerospace Corporation", "Ultor Corporation", "TranStar Corporation",
  "Seegson", "Concordance Extraction Corporation", "Hammond Robotics",
  "Interstellar Manufacturing Corporation", "Misriah Armory", "Kel-Morian Combine",
  "Elkoss Combine", "Kassa Fabrication", "Binary Helix", "Hahne-Kedar",
  "ExoGeni Corporation", "Armax Arsenal", "Devlon Industries", "Sirta Foundation",
  "Spacers Choice", "Fontaine Futuristics", "Ryan Industries", "Blume Corporation",
  "EuroCorp", "Renraku Computer Systems", "Saeder-Krupp", "Aztechnology",
  "Ares Macrotechnology", "Mitsuhama Computer Technologies", "Anaheim Electronics",
  "Hanka Robotics", "Encom", "Nakatomi Trading Corporation",
]);

const TICKER = /^[A-Z]{2,5}$/;

function isEnabled(env = process.env) {
  return String(env.EVEJS_PLAYER_BOTS_SCIFI_CORPORATION_NAMES ?? "1").trim() !== "0";
}

// Ticker options for a name, most natural first: the initials, then the
// first letters of a one-word name, then longer letter runs.
function tickerCandidates(name) {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase();
  const initials = words.map((word) => word[0]).join("").toUpperCase().replace(/[^A-Z]/g, "");
  const candidates = [];
  const add = (value) => {
    const ticker = String(value || "").slice(0, 5);
    if (TICKER.test(ticker) && !candidates.includes(ticker)) candidates.push(ticker);
  };
  if (initials.length >= 2) add(initials);
  for (let length = 3; length <= 5; length += 1) add(letters.slice(0, length));
  if (words.length > 1) {
    const last = words[words.length - 1].toUpperCase().replace(/[^A-Z]/g, "");
    for (let extra = 1; extra <= 3; extra += 1) add(initials.slice(0, -1) + last.slice(0, 1 + extra));
  }
  for (let start = 1; start + 3 <= letters.length && candidates.length < 12; start += 1) {
    add(letters[0] + letters.slice(start, start + 3));
  }
  return candidates;
}

function shuffled(list, random) {
  const copy = list.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.min(index, Math.floor(random() * (index + 1)));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

// Returns { name, ticker } for a new corporation, or null when the list is
// off or every name (or every ticker for the free names) is taken.
function chooseCorporationName(options = {}) {
  if (!isEnabled(options.env)) return null;
  const authority = options.authority || require("../corporation/corporationState");
  for (const name of shuffled(NAMES, options.random || Math.random)) {
    if (authority.findCorporationByName(name) || authority.findAllianceByExactName(name)) continue;
    const ticker = tickerCandidates(name).find((candidate) =>
      !authority.findCorporationByTickerName(candidate) && !authority.findAllianceByShortName(candidate));
    if (ticker) return { name, ticker };
  }
  return null;
}

// Fallback names once the list above is used up: "<prefix> <specialty word>",
// e.g. "Kestrel Freight Consortium". Never the old "EVEJS <specialty>" names.
const PREFIXES = Object.freeze([
  "Kestrel", "Aurora", "Vanguard", "Obsidian", "Halcyon", "Meridian", "Corvus", "Tamarind",
  "Solace", "Ironclad", "Zenith", "Cobalt", "Sable", "Perihelion", "Ardent", "Vesper",
  "Talon", "Nimbus", "Helix", "Bastion", "Calyx", "Driftwood", "Ember", "Gallowglass",
  "Harrow", "Ionis", "Juniper", "Kepler", "Lodestar", "Mirage", "Nadir", "Onyx",
  "Paragon", "Quasar", "Riven", "Starling", "Thorne", "Umbra", "Valkyr", "Wyvern",
]);
const SPECIALTY_WORDS = Object.freeze({
  trade: ["Freight Consortium", "Trading House", "Exchange", "Merchant League", "Commerce Guild"],
  industry: ["Fabrication Works", "Foundry", "Heavy Industries", "Manufacturing Combine", "Assembly Yards"],
  planetary: ["Colonial Holdings", "Extraction Group", "Planetary Ventures", "Terraform Concern", "Surface Works"],
  security: ["Defense Corps", "Security Directorate", "Guard Legion", "Patrol Command", "Shield Company"],
  piracy: ["Raiders", "Corsairs", "Reavers", "Cutthroat Company", "Black Fleet"],
  sovereignty: ["Frontier Holdings", "Expeditionary Force", "Pioneer Command", "Outer Rim Compact", "Claimholders"],
});
const LEGACY_PREFIX = /^\s*evejs\b/i;

function isLegacyName(name) {
  return LEGACY_PREFIX.test(String(name || ""));
}

function generateCorporationName(specialtyID = "", options = {}) {
  const authority = options.authority || require("../corporation/corporationState");
  const random = options.random || Math.random;
  const words = SPECIALTY_WORDS[specialtyID] || Object.values(SPECIALTY_WORDS).flat();
  for (const suffix of shuffled(words, random)) {
    for (const prefix of shuffled(PREFIXES, random)) {
      const name = `${prefix} ${suffix}`;
      if (authority.findCorporationByName(name) || authority.findAllianceByExactName(name)) continue;
      const ticker = tickerCandidates(name).find((candidate) =>
        !authority.findCorporationByTickerName(candidate) && !authority.findAllianceByShortName(candidate));
      if (ticker) return { name, ticker };
    }
  }
  return null;
}

module.exports = { NAMES, chooseCorporationName, generateCorporationName, isLegacyName, isEnabled, tickerCandidates };
