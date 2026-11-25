"use strict";

// The redesigned dashboard: every icon it asks for exists, every script the
// page loads can be served, every element the shell looks up is in the page,
// and the small helpers behave.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DASHBOARD = path.join(__dirname, "../addons/playerbots/dashboard");
const read = (file) => fs.readFileSync(path.join(DASHBOARD, file), "utf8");
const scripts = fs.readdirSync(path.join(DASHBOARD, "js")).filter((name) => name.endsWith(".js"));

test("every icon the dashboard draws is in the icon set", async () => {
  const { ICON_NAMES, icon } = await import("../addons/playerbots/dashboard/js/icons.js");
  const known = new Set(ICON_NAMES);
  const used = new Set();
  for (const name of scripts) {
    for (const match of read(`js/${name}`).matchAll(/\bicon\(\s*"([a-z-]+)"/g)) used.add(match[1]);
    for (const match of read(`js/${name}`).matchAll(/\bicon: "([a-z-]+)"/g)) used.add(match[1]);
  }
  // Icons chosen at run time from these lists.
  for (const list of read("js/view-activity.js").matchAll(/return "([a-z-]+)";/g)) used.add(list[1]);
  for (const list of read("js/rail.js").matchAll(/return "([a-z-]+)";/g)) used.add(list[1]);
  const missing = [...used].filter((name) => !known.has(name));
  assert.deepEqual(missing, []);
  assert.match(icon("activity"), /^<svg class="icon" width="20" height="20" viewBox="0 0 24 24"/);
  assert.match(icon("search", { label: "Search" }), /role="img" aria-label="Search"/);
});

test("the dashboard server serves every script, and the shell finds every element it uses", () => {
  // The same names dashboard-server.js accepts for static files.
  const served = /^\/((?:js\/)?[a-z0-9][a-z0-9-]*\.(html|js|css|svg))$/;
  for (const name of scripts) assert.match(`/js/${name}`, served, name);
  const html = read("index.html");
  for (const name of ["app.js", "rail.js", "palette.js", "drawer.js"]) {
    for (const match of read(`js/${name}`).matchAll(/\$\("([a-z-]+)"\)/g)) {
      const id = match[1];
      const dynamic = /^(act|corp|hist|names|reset|seed|settings|guide|palette|live)-/.test(id) || id === "palette-input";
      if (!dynamic) assert.match(html, new RegExp(`id="${id}"`), `${name} looks up #${id}`);
    }
  }
});

test("CSV cells are quoted and formula-looking text is defused", async () => {
  const { csvCell } = await import("../addons/playerbots/dashboard/js/csv.js");
  assert.equal(csvCell("Tyrell"), "Tyrell");
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-0.3), "-0.3");
  assert.equal(csvCell("-0.3"), "-0.3");
  assert.equal(csvCell("-cmd"), "'-cmd");
  assert.equal(csvCell(null), "");
});

test("trend lines need two readings", async () => {
  const { sparkline } = await import("../addons/playerbots/dashboard/js/ui.js");
  assert.equal(sparkline([3]), "");
  const svg = sparkline([1, 4, 2]);
  assert.match(svg, /<svg class="spark"/);
  assert.match(svg, /class="line" d="M0\.0 /);
});

test("preferences work without browser storage", async () => {
  const prefs = await import("../addons/playerbots/dashboard/js/prefs.js");
  assert.equal(prefs.prefs().theme, "dark");
  assert.equal(prefs.togglePin(140000005, "Ilias Oranthe"), true);
  assert.equal(prefs.isPinned(140000005), true);
  assert.equal(prefs.togglePin(140000005), false);
  prefs.setPref("refreshSeconds", 30);
  assert.equal(prefs.prefs().refreshSeconds, 30);
});
