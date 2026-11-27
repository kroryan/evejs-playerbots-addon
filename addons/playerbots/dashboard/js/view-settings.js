// Settings: autonomous work, population, capacity, advanced timings, the
// name library and the roster reset. The page is not redrawn by the timer so
// edits are never lost; seeding status refreshes on its own.

import { getJSON, postJSON } from "./api.js";
import { $, esc, num, toast, confirmDialog, pageHead, icon, notice } from "./ui.js";

export const autoRefresh = false;

const FIELDS = [
  // [name, label, unit conversion, min, max, step, hint, group]
  ["rosterTarget", "Roster target", null, 30, 15000, 1, "Pilots to create. Seeding stops here.", "population"],
  ["rosterCeiling", "Roster ceiling", null, 30, 15000, 1, "Most pilots this configuration allows.", "population"],
  ["maxOnline", "Most pilots online", null, 1, 5000, 1, "Pilots above this take turns.", "population"],
  ["connectionWindowHours", "Online rotation (hours)", ["connectionWindowMs", 3_600_000], 0.083333333, 168, "any", "How long a group stays online before the next takes over.", "population"],
  ["maxPerSystem", "Most pilots per system", null, 1, 300, 1, "Stops pilots entering space in a full system; the director moves residents out.", "population"],
  ["maxConcurrentWork", "Work slots", null, 1, 5000, 1, "Pilots that may run operations at once.", "work"],
  ["maxConcurrentRelocations", "Relocations at once", null, 1, 1000, 1, "", "work"],
  ["maxConcurrentColonySetups", "PI colony setups at once", null, 1, 500, 1, "", "work"],
  ["homeRangeJumps", "Stay within (jumps of HQ)", null, 0, 30, 1, "Between jobs, bots further than this from their corporation's headquarters fly home first. 0 lets them roam.", "home"],
  ["allianceMode", "Alliance mode (0 off, 1 karma, 2 population)", null, 0, 2, 1, "How bot corporations form alliances besides the ones you set up on the Alliances page: 0 none, 1 corporations with a shared enemy ally, 2 each empire's corporations band together at once.", "home"],
  ["riskTolerance", "Risk tolerance (0 high-sec, 1 low-sec, 2 null-sec)", null, 0, 2, 1, "How far into dangerous space bots work around their headquarters: 0 keeps miners in high-sec, 1 lets them into low-sec, 2 into null-sec.", "home"],
  ["maxBotFleets", "Bot fleets at once", null, 0, 1000, 1, "Mining and combat fleets the bot corporations form on their own.", "fleets"],
  ["botFleetSize", "Pilots per bot fleet", null, 2, 10, 1, "The commander included.", "fleets"],
  ["directorThinkMinSeconds", "Director think minimum (s)", ["directorThinkMinMs", 1000], 15, 3600, 1, "", "advanced"],
  ["directorThinkMaxSeconds", "Director think maximum (s)", ["directorThinkMaxMs", 1000], 15, 3600, 1, "", "advanced"],
  ["directorInitialSpreadSeconds", "Director initial spread (s)", ["directorInitialSpreadMs", 1000], 1, 3600, 1, "", "advanced"],
  ["directorSliceBudgetMs", "Director slice budget (ms)", null, 0, 100, 1, "Longest unbroken slice of a director pass; 0 never yields.", "advanced"],
  ["addonConcurrency", "Bot steps in parallel", null, 1, 100, 1, "Lowered automatically under load.", "advanced"],
  ["addonCycleIntervalSeconds", "Cycle interval (s)", ["addonCycleIntervalMs", 1000], 30, 86400, 1, "", "advanced"],
  ["addonBotDelayMs", "Delay per bot (ms)", null, 0, 5000, 1, "", "advanced"],
  ["addonRequestTimeoutSeconds", "EveJS request timeout (s)", ["addonRequestTimeoutMs", 1000], 10, 600, 1, "Dashboard reads cap this at 30 s.", "advanced"],
  ["rosterSeedBatchSize", "Seed batch size", null, 1, 10, 1, "Hard cap 10.", "seeding"],
  ["rosterSeedIntervalSeconds", "Time between batches (s)", ["rosterSeedIntervalMs", 1000], 5, 300, 1, "", "seeding"],
  ["rosterSeedMaxEventLoopP95Ms", "Pause above event-loop p95 (ms)", null, 25, 250, 1, "Hard cap 250 ms.", "seeding"],
  ["rosterSeedMaxProcessCpuPercent", "Pause above EveJS CPU (%)", null, 25, 95, 1, "Hard cap 95%.", "seeding"],
  ["rosterSeedMaximumSingleBotMs", "Slowest allowed pilot creation (ms)", null, 25, 1000, 1, "Hard cap 1,000 ms.", "seeding"],
];

let saved = null;
let defaults = null;
let seedTimer = null;
let ctxRef = null;

function toForm(settings, field) {
  const [name, , convert] = field;
  if (!convert) return settings[name];
  const value = Number(settings[convert[0]]) / convert[1];
  return Number.isFinite(value) ? Number(value.toPrecision(8)) : "";
}

// Settings saved in the Windows launcher are shown but locked here.
const LAUNCHER_NOTE = "Set in EVEJS Launcher (Mods → Playerbots → Configure)";
function settingKey(field) {
  return field[2] ? field[2][0] : field[0];
}
function isLocked(key) {
  return Array.isArray(saved.launcherManagedFields) && saved.launcherManagedFields.includes(key);
}

function fieldHtml(field) {
  const [name, label, , min, fallbackMax, step, fallbackHint] = field;
  const cpuLimit = name === "rosterSeedMaxProcessCpuPercent"
    ? saved.maximums?.[name]
    : undefined;
  const hasServerLimit = Number.isInteger(cpuLimit) && cpuLimit >= min;
  const max = hasServerLimit ? cpuLimit : fallbackMax;
  const hint = hasServerLimit ? `Hard cap ${max}%.` : fallbackHint;
  const def = defaults ? toForm(defaults, field) : null;
  const locked = isLocked(settingKey(field));
  const note = locked
    ? `<small class="default-hint">${esc(LAUNCHER_NOTE)}</small>`
    : def !== null && def !== undefined ? `<small class="default-hint">Default ${esc(def)}</small>` : "";
  return `<label>${esc(label)}<input class="field" name="${name}" type="number" min="${min}" max="${max}" step="${step}" required value="${esc(toForm(saved, field) ?? "")}"${locked ? ` disabled title="${esc(LAUNCHER_NOTE)}"` : ""}>${hint ? `<small>${esc(hint)}</small>` : ""}${note}</label>`;
}

function checkHtml(key, label, detail = "") {
  const locked = isLocked(key);
  return `<label class="switch"${locked ? ` title="${esc(LAUNCHER_NOTE)}"` : ""}><span><strong>${label}</strong><small>${detail}${locked ? ` ${esc(LAUNCHER_NOTE)}.` : ""}</small></span><input type="checkbox" role="switch" name="${key}" ${saved[key] ? "checked" : ""}${locked ? " disabled" : ""}></label>`;
}

function group(id) {
  return FIELDS.filter((field) => field[7] === id).map(fieldHtml).join("");
}

function seedText(seed, roster) {
  const last = seed.lastBatch;
  const target = Number(saved.rosterTarget) || 0;
  const count = Number(last && last.rosterCount) || roster;
  const progress = target ? Math.min(100, Math.round(count * 100 / target)) : 0;
  const state = seed.running ? "Creating pilots now" : seed.enabled ? (count >= target ? "Seeding finished" : "Seeding on") : "Seeding off";
  const back = last && last.backpressure ? `Backing off: ${last.stopReason || "server load"}.` : "";
  return `${icon("users", { size: 18 })}<div style="flex:1"><div class="switch-row"><div><strong>${esc(state)}</strong> · ${num(count)} of ${num(target)} pilots (${progress}%)</div><span class="bar" style="width:220px"><i style="width:${progress}%"></i></span></div>
    <p class="muted" style="margin:6px 0 0;font-size:12.5px">Event loop p95 ${Number(seed.eventLoopP95Ms || 0).toFixed(0)} ms (limit ${num(seed.eventLoopSafetyLimitMs)}) · EveJS CPU ${Number(seed.processCpuPercent || 0).toFixed(0)}% (limit ${num(seed.processCpuSafetyLimitPercent)}%)${last ? ` · last batch created ${num(last.created)} ${last.at ? `at ${esc(new Date(last.at).toLocaleTimeString())}` : ""}` : ""}. ${esc(back)}</p></div>`;
}

async function refreshSeed(roster) {
  if (!$("seed-status")) { clearInterval(seedTimer); seedTimer = null; return; }
  try { $("seed-status").innerHTML = seedText(await getJSON("/api/seed-status"), roster); } catch { /* next tick */ }
}

function pageHtml(effectiveAutowork, roster) {
  return `${pageHead("settings", "Settings", "Saved changes apply to EveJS and the add-on without a restart.")}
  <form id="settings-form">
    <div class="panel"><div class="panel-head"><div><h2>${icon("bolt")}Autonomous work</h2><p>When off, the director gives no pilot new work. Running operations finish and dashboard orders still work.</p></div></div>
      <div class="panel-body"><div class="form-grid">
        ${checkHtml("autoworkEnabled", "Autonomous work", `The director hands out work on its own. Now ${effectiveAutowork ? "on" : "off"}.`)}
        ${checkHtml("rosterSeedEnabled", "Gradual roster seeding", "Creates pilots in small batches until the roster target is reached.")}
        ${Object.hasOwn(saved, "directorWhileSeeding") ? checkHtml("directorWhileSeeding", "Work while seeding", "When off, the director gives no pilot new work until seeding reaches the roster target.") : ""}
      </div>
      <div id="seed-status" class="notice info" style="margin:14px 0 0"></div></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${icon("users")}Population</h2><p>How many pilots exist, how many are online, and where they may gather</p></div></div><div class="panel-body"><div class="form-grid">${group("population")}</div></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${icon("briefcase")}Work capacity</h2><p>How much work runs at the same time</p></div></div><div class="panel-body"><div class="form-grid">${group("work")}</div></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${icon("home")}Headquarters</h2><p>Bots live and work around their corporation's headquarters: the HQ set with <code>/bots corp hq set</code>, or the Upwell structure the corporation built as its HQ. Miners work from it (or the nearest belt station), ratters look for sites around it, and pilots fly home between jobs. Traders still follow the markets; corporations without an HQ roam as before.</p></div></div><div class="panel-body"><div class="form-grid">${group("home")}</div></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${icon("fleet")}Bot fleets</h2><p>Bot corporations fly together like players: a miner or ratter leads, and corpmates working the same station or system join its fleet. You can watch these fleets on the Fleets page but not change them.</p></div></div><div class="panel-body"><div class="form-grid">${checkHtml("botFleetsEnabled", "Bot fleets", "Bots form their own mining and combat fleets.")}${group("fleets")}</div></div></div>
    <div class="panel"><div class="panel-body" style="padding-top:14px"><details class="advanced"><summary>${icon("chevron-right", { size: 16 })}Advanced: director, add-on cycle and seeding safety</summary>
      <h3 class="section-label">Director and add-on cycle</h3><div class="form-grid">${group("advanced")}</div>
      <h3 class="section-label">Seeding safety</h3><div class="form-grid">${group("seeding")}</div></details></div></div>
    <div class="save-bar" id="settings-bar"><span class="muted" id="settings-saved">${saved.updatedAt ? `Last saved ${esc(new Date(saved.updatedAt).toLocaleString())}` : "Showing environment defaults"}</span>
      <span class="actions"><button type="button" class="btn ghost" id="settings-defaults">${icon("refresh")}<span>Reset to defaults</span></button><button type="submit" class="btn primary" id="settings-save">${icon("check")}<span>Save settings</span></button></span></div>
  </form>
  <div class="panel"><div class="panel-head"><div><h2>${icon("hash")}Corporation and alliance names</h2><p>Applies to organizations created from now on. Empty lists keep the original naming.</p></div></div>
    <div class="panel-body"><textarea id="names-text" class="name-library-editor" rows="12" spellcheck="false" aria-label="Name library (JSON)"></textarea>
    <div class="save-bar"><span class="muted" id="names-status">Loading…</span><span class="actions"><button type="button" class="btn ghost" id="names-template">${icon("list")}<span>Load template</span></button><button type="button" class="btn primary" id="names-save">${icon("check")}<span>Save name library</span></button></span></div></div></div>
  <div class="panel"><div class="panel-head"><div><h2>${icon("world")}World seed</h2><p>Optional. Skips the slow start: every corporation gets its own null-sec region, an Astrahus headquarters, a Raitaru and an Athanor (online, fuelled, with service modules), 3 claimed systems, 2B ISK, and its bots docked in its structures. Written straight into the game data; nothing is flown or bought. Running it again only finishes what is missing.</p></div></div>
    <div class="panel-body"><div class="toolbar"><button type="button" class="btn ghost" id="world-plan">${icon("list")}<span>Preview the plan</span></button>
      <label class="check"><input type="checkbox" id="world-sov" checked> Sovereignty in claimed systems (founds an alliance for corporations without one)</label>
      <label class="check"><input type="checkbox" id="world-move" checked> Move bots into their structures now</label>
      <label class="check"><input type="checkbox" id="world-market" checked> Market orders and manufacturing jobs</label></div>
    <div id="world-plan-view"></div>
    <div class="toolbar" style="margin-top:10px"><label class="stack">Type SEED NEW EDEN to confirm<input class="field" id="world-confirm" autocomplete="off" spellcheck="false"></label><button type="button" class="btn primary" id="world-start">${icon("check")}<span>Seed New Eden</span></button></div>
    <p class="muted" id="world-status" style="margin:10px 0 0">Loading…</p></div></div>
  <div class="panel danger-zone"><div class="panel-head"><div><h2>${icon("trash")}Delete all bots</h2><p>Cancels every playerbot's market orders, stops its work and deletes the character. Assets go to its corporation. Human characters are untouched. This cannot be undone.</p></div></div>
    <div class="panel-body"><div class="toolbar"><label class="stack">Type DELETE ALL BOTS to confirm<input class="field" id="reset-confirm" autocomplete="off" spellcheck="false"></label><label class="check"><input type="checkbox" id="reset-reseed" checked> Seed a new roster afterwards</label><button type="button" class="btn danger" id="reset-start">${icon("trash")}<span>Delete all bots</span></button></div>
    <p class="muted" id="reset-status" style="margin:10px 0 0">Loading…</p></div></div>`;
}

function bodyFromForm(form) {
  const body = {};
  for (const field of FIELDS) {
    const [name, , convert] = field;
    // Servers from before a setting existed do not accept it.
    if (isLocked(settingKey(field)) || !Object.hasOwn(saved, settingKey(field))) continue;
    const value = Number(form.elements.namedItem(name).value);
    if (convert) body[convert[0]] = Math.round(value * convert[1]);
    else body[name] = value;
  }
  for (const key of ["autoworkEnabled", "rosterSeedEnabled", "directorWhileSeeding", "botFleetsEnabled"]) {
    if (!isLocked(key) && Object.hasOwn(saved, key)) body[key] = form.elements.namedItem(key).checked;
  }
  return body;
}

async function confirmSaved(body, attempts) {
  let pending = Object.keys(body);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5_000));
    const data = await getJSON("/api/settings");
    const current = data.settings || data;
    pending = Object.keys(body).filter((key) => current[key] !== undefined && String(current[key]) !== String(body[key]));
    if (!pending.length) return [];
  }
  return pending;
}

async function save(event) {
  event.preventDefault();
  const form = $("settings-form");
  const body = bodyFromForm(form);
  const button = $("settings-save");
  button.disabled = true;
  let timedOut = false;
  try {
    await postJSON("/api/settings", body);
  } catch (error) {
    if (error.status && error.status < 500) { toast(error.message, "bad"); button.disabled = false; return; }
    timedOut = true;
    toast("EveJS did not confirm in time; checking whether the change was saved…");
  }
  try {
    const pending = await confirmSaved(body, timedOut ? 6 : 1);
    if (pending.length) toast(`Not saved yet: ${pending.join(", ")}. Try again.`, "bad");
    else toast("Settings saved.", "good");
    await load(true);
  } catch (error) {
    toast(`Could not read the settings back: ${error.message}`, "bad");
  } finally {
    if ($("settings-save")) $("settings-save").disabled = false;
  }
}

function describeReset(reset) {
  if (!reset || reset.status === "idle") return "No roster reset has run.";
  if (reset.status === "running") return `Removing bots: ${num(reset.removed)} of ${num(reset.total)} done${reset.failed ? `, ${num(reset.failed)} failed` : ""}.`;
  return `Last reset finished ${new Date(reset.finishedAt).toLocaleString()}: ${num(reset.removed)} of ${num(reset.total)} removed${reset.failed ? `, ${num(reset.failed)} failed` : ""}.`;
}

async function loadReset() {
  try {
    const data = await getJSON("/api/roster-reset");
    if (!$("reset-status")) return;
    $("reset-status").textContent = describeReset(data.reset);
    $("reset-start").disabled = data.reset && data.reset.status === "running";
    if (data.reset && data.reset.status === "running") setTimeout(() => void loadReset(), 5_000);
  } catch (error) {
    if ($("reset-status")) $("reset-status").textContent = `Reset status unavailable: ${error.message}`;
  }
}

function describeWorldSeed(seed) {
  if (!seed || seed.status === "idle") return "The world seed has not run.";
  const errors = seed.errors && seed.errors.length ? ` ${seed.errors.length} note(s); latest: ${seed.errors[seed.errors.length - 1]}` : "";
  if (seed.status === "running") return `Seeding: ${seed.step || "starting"}${seed.toMove ? ` · bots moved ${num(seed.moved)} of ${num(seed.toMove)}` : ""}.${errors}`;
  if (seed.status === "interrupted") return `The last seed was interrupted by a restart. Run it again to finish.${errors}`;
  return `World seed ${seed.status} ${seed.finishedAt ? new Date(seed.finishedAt).toLocaleString() : ""}: ${num(seed.corporations.length)} corporations, ${num(seed.moved)} bots moved.${errors}`;
}

async function loadWorldSeed() {
  try {
    const data = await getJSON("/api/world-seed");
    if (!$("world-status")) return;
    $("world-status").textContent = describeWorldSeed(data.seed);
    $("world-start").disabled = data.seed && data.seed.status === "running";
    if (data.seed && data.seed.status === "running") setTimeout(() => void loadWorldSeed(), 5_000);
  } catch (error) {
    if ($("world-status")) $("world-status").textContent = `World seed status unavailable: ${error.message}`;
  }
}

async function previewWorldSeed() {
  $("world-plan-view").innerHTML = `<p class="muted">Planning…</p>`;
  try {
    const { plan } = await getJSON("/api/world-seed?plan=1");
    $("world-plan-view").innerHTML = `
      ${plan.missingTypes.length ? `<p class="bad">Missing from the static data: ${esc(plan.missingTypes.join(", "))}. The seed will refuse to run.</p>` : ""}
      <div class="table-wrap"><table class="table"><thead><tr><th>Corporation</th><th>Region</th><th>Home</th><th>Claims</th><th>Bots</th><th>Notes</th></tr></thead><tbody>
      ${plan.corporations.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.regionName || "")}</td><td>${esc(c.homeSystemName || "")}</td><td>${esc((c.claimNames || []).join(", "))}</td><td>${num(c.bots)}</td>
        <td>${esc([c.error, c.existingRegion ? "keeps its current region" : "", c.needsAlliance ? "new alliance for sovereignty" : ""].filter(Boolean).join("; "))}</td></tr>`).join("")}
      </tbody></table></div>`;
  } catch (error) { $("world-plan-view").innerHTML = `<p class="bad">${error.message}</p>`; }
}

async function loadNames() {
  try {
    const data = await getJSON("/api/name-library");
    $("names-text").value = data.text;
    $("names-status").textContent = data.warning || "Loaded.";
  } catch (error) { $("names-status").textContent = error.message; }
}

async function load(fresh) {
  const [data, summary] = await Promise.all([getJSON("/api/settings"), ctxRef ? ctxRef.loadSummary(false) : null]);
  saved = data.settings || {};
  defaults = saved.defaults || null;
  const roster = Number(summary && summary.roster && summary.roster.total) || 0;
  if (!fresh && $("settings-form")) return;
  $("view").innerHTML = pageHtml(data.effectiveAutoworkEnabled, roster);
  void refreshSeed(roster);
  clearInterval(seedTimer);
  seedTimer = setInterval(() => void refreshSeed(roster), 10_000);
  $("settings-form").addEventListener("submit", (event) => void save(event));
  const markDirty = () => {
    $("settings-bar").classList.add("dirty");
    $("settings-saved").textContent = "Unsaved changes";
  };
  $("settings-form").addEventListener("input", markDirty);
  $("settings-form").addEventListener("change", markDirty);
  $("settings-defaults").addEventListener("click", async () => {
    if (!defaults || !(await confirmDialog("Reset settings", "Reset every setting on this page to its default and save?", "Reset and save"))) return;
    saved = { ...saved, ...defaults };
    const form = $("settings-form");
    for (const field of FIELDS) if (!isLocked(settingKey(field))) form.elements.namedItem(field[0]).value = String(toForm(defaults, field) ?? "");
    for (const key of ["autoworkEnabled", "rosterSeedEnabled", "directorWhileSeeding"]) {
      const input = form.elements.namedItem(key);
      if (input && !isLocked(key)) input.checked = defaults[key] === true;
    }
    form.requestSubmit();
  });
  $("names-template").addEventListener("click", () => {
    $("names-text").value = JSON.stringify(Object.fromEntries(["amarr", "caldari", "gallente", "minmatar"].map((key) => [key, { corporations: [], alliances: [] }])), null, 2) + "\n";
    $("names-status").textContent = "Template loaded. Save to apply it.";
  });
  $("names-save").addEventListener("click", async () => {
    try {
      const data = await postJSON("/api/name-library", { text: $("names-text").value });
      $("names-text").value = data.text;
      $("names-status").textContent = data.message;
      toast(data.message, "good");
    } catch (error) { $("names-status").textContent = error.message; toast(error.message, "bad"); }
  });
  $("reset-start").addEventListener("click", async () => {
    const confirmation = $("reset-confirm").value.trim();
    if (confirmation !== "DELETE ALL BOTS") return toast("Type DELETE ALL BOTS exactly to confirm.", "bad");
    if (!(await confirmDialog("Delete all bots", "Delete every playerbot now? This cannot be undone.", "Delete all bots", true))) return;
    try {
      await postJSON("/api/roster-reset", { confirmation, seedAfterReset: $("reset-reseed").checked });
      $("reset-confirm").value = "";
      await loadReset();
    } catch (error) { toast(error.message, "bad"); }
  });
  $("world-plan").addEventListener("click", () => void previewWorldSeed());
  $("world-start").addEventListener("click", async () => {
    const confirmation = $("world-confirm").value.trim();
    if (confirmation !== "SEED NEW EDEN") return toast("Type SEED NEW EDEN exactly to confirm.", "bad");
    if (!(await confirmDialog("Seed New Eden", "Create structures, claims, sovereignty and ISK for every corporation and move their bots now?", "Seed New Eden"))) return;
    try {
      const data = await postJSON("/api/world-seed", { confirmation, sovereignty: $("world-sov").checked, moveBots: $("world-move").checked, ordersAndJobs: $("world-market").checked });
      $("world-confirm").value = "";
      toast(data.message || "World seed started.", "good");
      await loadWorldSeed();
    } catch (error) { toast(error.message, "bad"); }
  });
  void loadNames();
  void loadReset();
  void loadWorldSeed();
}

export async function render(ctx) {
  ctxRef = ctx;
  await load(ctx.fresh);
}
