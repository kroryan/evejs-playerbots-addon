// Fleets: every in-game fleet with bots in it. The fleet commander (FC)
// chooses what kind of fleet it is and which fitting the bots fly; the bots
// then fit up, meet the FC, dock and undock with the FC, follow the FC in
// warp and work the grid: mine, fight, haul or escort.

import { getJSON, postJSON } from "./api.js";
import { $, esc, num, toast, confirmDialog, pageHead, icon, emptyState, notice, portrait, stateTag, replaceKeepingFocus, rel } from "./ui.js";
import { openPilot } from "./drawer.js";

const TYPE_ICONS = { mining: "ore", combat: "target", hauling: "cargo", escort: "shield" };
// One line per card; the guide has the full description.
const TYPE_LINES = {
  mining: "Mine where the FC is. Ore goes into the FC's fleet hangar, or a jet can.",
  combat: "Kill every rat on the FC's grid, the FC's target first.",
  hauling: "Collect the fleet's jet cans and deliver them to the FC.",
  escort: "Stay close to the FC and fight what comes near.",
};
// What each duty stage looks like in the pilot list.
const STAGES = {
  muster: ["queued", "Reporting"],
  travel: ["travelling", "Travelling"],
  "to-station": ["travelling", "Docking"],
  undocking: ["travelling", "Undocking"],
  warping: ["travelling", "Warping"],
  docked: ["standby", "Docked with FC"],
  following: ["standby", "With the FC"],
  waiting: ["holding", "Waiting for FC"],
  mining: ["working", "Mining"],
  unloading: ["working", "Unloading"],
  engaging: ["working", "Fighting"],
  collecting: ["working", "Collecting cans"],
  delivering: ["working", "Delivering"],
  leaving: ["cooling", "Leaving"],
};

let data = null;
let activeFleet = 0;
let fitDraft = {};
const chosen = new Map(); // fleetID -> Set of bot characterIDs picked for duty
let busy = false;

function chosenFor(fleet) {
  if (!chosen.has(fleet.fleetID)) {
    const ids = fleet.doctrine.botIDs || [];
    chosen.set(fleet.fleetID, new Set(fleet.doctrine.active && ids.length ? ids : []));
  }
  return chosen.get(fleet.fleetID);
}

function where(member) {
  if (!member.online) return `<span class="muted">Offline</span>`;
  const place = member.docked ? esc(member.stationName || "a station") : `In space · ${esc(member.systemName || "")}`;
  return `${place}${member.docked && member.systemName ? `<span class="sub">${esc(member.systemName)}</span>` : ""}`;
}

function dutyCell(member, fleet) {
  const duty = member.duty || {};
  if (duty.onDuty) {
    const [state, label] = STAGES[duty.stage] || ["working", duty.stage || "On duty"];
    return `${stateTag(state, duty.withoutFit ? `${label} · no ${fleet.doctrine.fleetType} ship` : label)}<span class="sub">${esc(duty.lastAction || "")}</span>`;
  }
  if (duty.refitting) return `${stateTag("queued", "Fetching ship")}<span class="sub">${esc(duty.note || duty.currentWork)}</span>`;
  if (duty.note) return `${stateTag("holding", "Waiting")}<span class="sub">${esc(duty.note)}</span>`;
  if (duty.refitError) return `${stateTag("paused", "No ship")}<span class="sub">${esc(duty.refitError)}</span>`;
  if (duty.currentWork) return `${stateTag("idle", "Own work")}<span class="sub">${esc(duty.currentWork)}</span>`;
  return `${stateTag("idle", "Off duty")}`;
}

// "mine (to-belt)" -> "Mining trip: to belt".
function workLabel(text) {
  const match = /^([a-z-]+) \(([^)]*)\)$/.exec(String(text || ""));
  if (!match) return text || "Its own work";
  const kinds = { mine: "Mining trip", combat: "Ratting", "fleet-duty": "Fleet duty" };
  return `${kinds[match[1]] || match[1]}: ${match[2].replace(/-/g, " ")}`;
}

function memberRows(fleet) {
  const picked = chosenFor(fleet);
  const readOnly = Boolean(fleet.botLed);
  return fleet.members.map((member) => {
    const tags = member.isCommander ? `<span class="pill good fleet-fc">${icon("flag", { size: 13 })}FC</span>` : member.isBot ? "" : `<span class="pill">Person</span>`;
    const select = member.isBot && !member.isCommander
      ? `<input type="checkbox" data-pick="${member.characterID}" aria-label="Choose ${esc(member.name)}"${picked.has(member.characterID) ? " checked" : ""}>`
      : "";
    const selected = !readOnly && picked.has(member.characterID);
    return `<tr class="${member.isBot ? "clickable" : ""}${selected ? " selected" : ""}" ${member.isBot ? `data-pilot="${member.characterID}" tabindex="0"` : ""}>
      ${readOnly ? "" : `<td class="select-cell">${select}</td>`}
      <td><div class="pilot">${portrait(member.characterID)}<span><strong>${esc(member.name)}</strong> ${tags}<span class="sub">${member.isBot ? esc(member.specialty || "bot") : "Human pilot"}</span></span></div></td>
      <td>${esc(member.shipTypeName || "—")}</td>
      <td>${where(member)}</td>
      <td class="fleet-duty-cell">${member.isCommander ? (readOnly ? `${stateTag("working", "Leading")}<span class="sub">${esc(workLabel(member.duty && member.duty.currentWork))}</span>` : `<span class="muted">Commands the fleet</span>`) : member.isBot ? dutyCell(member, fleet) : `<span class="muted">—</span>`}</td>
    </tr>`;
  }).join("");
}

function hangarHtml(commander) {
  const hangar = commander.fleetHangar || {};
  if (!hangar.capacity) {
    return `<span class="pill">${icon("cargo", { size: 14 })}No fleet hangar</span>`;
  }
  const percent = Math.min(100, Math.round(hangar.used * 100 / hangar.capacity));
  return `<span class="fleet-hangar"><span>${icon("cargo", { size: 14 })}Fleet hangar ${num(Math.round(hangar.used))} / ${num(Math.round(hangar.capacity))} m³</span><span class="bar${percent > 90 ? " over" : ""}"><i style="width:${percent}%"></i></span>${hangar.fleetAccess ? "" : `<span class="pill warn">Fleet access off</span>`}</span>`;
}

function typeCards(fleet) {
  const current = fleet.doctrine.fleetType;
  return `<div class="fleet-types" role="radiogroup" aria-label="Kind of fleet">${data.fleetTypes.map((type) => `<button type="button" class="fleet-type${type.key === current ? " on" : ""}" title="${esc(type.summary)}" role="radio" aria-checked="${type.key === current}" data-type="${esc(type.key)}">
      <span class="fleet-type-icon">${icon(TYPE_ICONS[type.key] || "fleet", { size: 22 })}</span>
      <span><strong>${esc(type.label)}</strong><small>${esc(TYPE_LINES[type.key] || type.summary)}</small></span>
      ${type.key === current ? `<span class="check-mark">${icon("check", { size: 16 })}</span>` : ""}
    </button>`).join("")}</div>`;
}

function fitPicker(fleet) {
  const type = fleet.doctrine.fleetType;
  if (!type) return "";
  const label = data.fleetTypes.find((entry) => entry.key === type)?.label || type;
  const current = Number(fleet.doctrine.fits[type]) || 0;
  const draft = fitDraft[fleet.fleetID] ?? (current && !fleet.fittings.some((fit) => fit.fittingID === current) ? String(current) : "");
  const known = fleet.fittings.some((fit) => fit.fittingID === current);
  const options = [
    `<option value="0"${!current ? " selected" : ""}>Built-in Playerbots ${esc(label.toLowerCase())} fit</option>`,
    ...fleet.fittings.map((fit) => `<option value="${fit.fittingID}"${fit.fittingID === current ? " selected" : ""}>${esc(fit.name)} · ${esc(fit.shipTypeName || "ship")} (${esc(fit.owner)})</option>`),
    current && !known ? `<option value="${current}" selected>Saved fitting ${current}</option>` : "",
  ].join("");
  return `<div class="fleet-fit">
    <label>Ship for ${esc(label.toLowerCase())} duty<select class="field" id="fleet-fit-select" data-fleet-fit>${options}</select>
      <small>Bots that do not have this fit go and get it, then come back to the FC. The FC's personal, corporation and alliance fittings are listed.</small></label>
    <label>Or a fitting ID<span class="fleet-fit-id"><input class="field" id="fleet-fit-id" data-fleet-fit-id inputmode="numeric" placeholder="e.g. 4242" value="${esc(draft)}"><button type="button" class="btn small" id="fleet-fit-apply">${icon("check")}<span>Use</span></button></span>
      <small>Any fitting the FC can see, such as a shared community fit.</small></label>
  </div>`;
}

function dutyBar(fleet) {
  const doctrine = fleet.doctrine;
  const bots = fleet.members.filter((member) => member.isBot);
  const picked = [...chosenFor(fleet)].filter((id) => bots.some((bot) => bot.characterID === id));
  const onDuty = bots.filter((bot) => bot.duty && bot.duty.onDuty).length;
  const ownWork = bots.filter((bot) => bot.duty && bot.duty.currentWork && !bot.duty.onDuty && !bot.duty.refitting).length;
  const status = doctrine.active
    ? `<span class="pill good">${icon("play", { size: 14 })}On duty · ${num(onDuty)} of ${num(doctrine.botIDs ? doctrine.botIDs.length : bots.length)} bots</span>`
    : `<span class="pill">${icon("pause", { size: 14 })}Off duty</span>`;
  const startLabel = picked.length ? `Start duty for ${num(picked.length)} chosen` : doctrine.active ? "Put every bot on duty" : "Start fleet duty";
  return `<div class="fleet-duty-bar">
    <div class="fleet-duty-status">${status}<span class="muted">${doctrine.fleetType ? "" : "Choose a kind of fleet first."}</span></div>
    <div class="actions">
      ${ownWork && doctrine.active ? `<button type="button" class="btn" id="fleet-release" title="Stops the bots' own jobs so they join now">${icon("bolt")}<span>Call in ${num(ownWork)} busy bot${ownWork === 1 ? "" : "s"}</span></button>` : ""}
      ${doctrine.active ? `<button type="button" class="btn danger" id="fleet-stop">${icon("stop")}<span>Stand down</span></button>` : ""}
      <button type="button" class="btn primary" id="fleet-start"${doctrine.fleetType && bots.length ? "" : " disabled"}>${icon("play")}<span>${startLabel}</span></button>
    </div>
  </div>`;
}

// A fleet the bots formed themselves: shown, never changed.
function botFleetPanel(fleet) {
  const commander = fleet.commander;
  const place = commander.online
    ? commander.docked ? `Docked at ${esc(commander.stationName || "a station")}` : `In space in ${esc(commander.systemName || "an unknown system")}`
    : "Offline";
  const type = data.fleetTypes.find((entry) => entry.key === fleet.doctrine.fleetType);
  return `<div class="panel fleet-panel bot-fleet" data-fleet="${fleet.fleetID}">
    <div class="panel-head fleet-head">
      <div class="pilot fleet-commander">${portrait(commander.characterID)}<span><strong>${esc(commander.name)}</strong> <span class="pill good fleet-fc">${icon("flag", { size: 13 })}FC</span>
        <span class="sub">${esc(fleet.name)} · ${place}${commander.shipTypeName ? ` · ${esc(commander.shipTypeName)}` : ""}</span></span></div>
      <div class="fleet-head-side"><span class="pill">${icon(TYPE_ICONS[fleet.doctrine.fleetType] || "fleet", { size: 14 })}${esc(type ? type.label : "Fleet")}</span>${hangarHtml(commander)}<span class="pill">${icon("users", { size: 14 })}${num(fleet.botCount)} bots</span></div>
    </div>
    <div class="panel-body">${notice(`The bots formed this fleet themselves${fleet.formedAt ? ` ${esc(rel(fleet.formedAt))}` : ""}. Its commander does its own ${esc(type ? type.label.toLowerCase() : "")} work and its corpmates fly with it. You can watch it, but not change it; it breaks up when the commander's job ends.`, "info", "fleet-note")}</div>
    <div class="table-wrap"><table class="fleet-members">
      <thead><tr><th>Pilot</th><th>Ship</th><th>Where</th><th>Fleet duty</th></tr></thead>
      <tbody id="fleet-members">${memberRows(fleet)}</tbody>
    </table></div>
  </div>`;
}

function fleetPanel(fleet) {
  if (fleet.botLed) return botFleetPanel(fleet);
  const commander = fleet.commander;
  const place = commander.online
    ? commander.docked ? `Docked at ${esc(commander.stationName || "a station")}` : `In space in ${esc(commander.systemName || "an unknown system")}`
    : "Offline";
  const accessHelp = commander.fleetHangar && commander.fleetHangar.capacity && !commander.fleetHangar.fleetAccess && fleet.doctrine.fleetType && ["mining", "hauling"].includes(fleet.doctrine.fleetType)
    ? notice(`The FC's ${esc(commander.shipTypeName)} has a fleet hangar, but fleet members may not use it. In game, open the ship's fleet hangar and turn on <strong>Allow fleet members access</strong>; until then miners use jet cans.`, "", "fleet-note")
    : "";
  return `<div class="panel fleet-panel" data-fleet="${fleet.fleetID}">
    <div class="panel-head fleet-head">
      <div class="pilot fleet-commander">${portrait(commander.characterID)}<span><strong>${esc(commander.name)}</strong> <span class="pill good fleet-fc">${icon("flag", { size: 13 })}FC</span>
        <span class="sub">${esc(fleet.name)} · ${place}${commander.shipTypeName ? ` · ${esc(commander.shipTypeName)}` : ""}</span></span></div>
      <div class="fleet-head-side">${hangarHtml(commander)}<span class="pill">${icon("users", { size: 14 })}${num(fleet.botCount)} bot${fleet.botCount === 1 ? "" : "s"} · ${num(fleet.humanCount)} ${fleet.humanCount === 1 ? "person" : "people"}</span></div>
    </div>
    <div class="panel-body">
      <h3 class="section-label">What kind of fleet is this?</h3>
      ${typeCards(fleet)}
      ${fitPicker(fleet)}
      ${accessHelp}
      ${dutyBar(fleet)}
    </div>
    <div class="table-wrap"><table class="fleet-members">
      <thead><tr><th class="select-cell"><input type="checkbox" id="fleet-pick-all" aria-label="Choose every bot"></th><th>Pilot</th><th>Ship</th><th>Where</th><th>Fleet duty</th></tr></thead>
      <tbody id="fleet-members">${memberRows(fleet)}</tbody>
    </table></div>
  </div>`;
}

function tabsHtml() {
  if (data.fleets.length < 2) return "";
  return `<div class="tabs" role="tablist" aria-label="Fleets">${data.fleets.map((fleet) => `<button type="button" role="tab" data-tab="${fleet.fleetID}" class="${fleet.fleetID === activeFleet ? "active" : ""}" aria-selected="${fleet.fleetID === activeFleet}">${icon(fleet.botLed ? "cpu" : "fleet")}<span>${esc(fleet.botLed ? `${fleet.commander.name} (bots)` : fleet.commander.name)}</span><span class="tab-count">${num(fleet.botCount)}</span></button>`).join("")}</div>`;
}

function howTo() {
  return `<div class="panel"><div class="panel-head"><div><h2>${icon("guide")}How to fly with bots</h2></div></div>
    <div class="panel-body"><ol class="fleet-steps">
      <li>In game, form a fleet. You are its commander (FC).</li>
      <li>Add bots: type <code>/playerbots fleet add Zara Vex</code> in any chat.</li>
      <li>Come back here, choose what kind of fleet it is, and press <strong>Start fleet duty</strong>.</li>
      <li>Bots fit up, meet you where you are docked, undock with you, warp after you and get to work on grid.</li>
    </ol>
    <p class="muted"><a href="#guide/fleet-duty">Read more in the guide</a></p></div></div>`;
}

function pageHtml() {
  const fleet = data.fleets.find((entry) => entry.fleetID === activeFleet);
  const people = data.fleets.filter((entry) => !entry.botLed).length;
  const bots = data.fleets.length - people;
  const subtitle = data.fleets.length
    ? `${[people ? `${num(people)} fleet${people === 1 ? "" : "s"} led by people` : "", bots ? `${num(bots)} the bots formed themselves` : ""].filter(Boolean).join(", ")}. Tell the bots in your fleet what kind of fleet it is; they fit up, stay with the FC and do the job.`
    : "Fleets with bots in them appear here.";
  return `<div id="fleets-page">${pageHead("fleet", "Fleets", subtitle)}
    ${data.fleets.length ? `${tabsHtml()}<div id="fleet-body">${fleetPanel(fleet)}</div>` : `<div class="panel">${emptyState("fleet", "No fleets with bots yet", "Form a fleet in game and add bots to it.")}</div>${howTo()}`}</div>`;
}

async function command(fleet, action, args = {}, success = "") {
  if (busy) return;
  busy = true;
  try {
    const result = await postJSON("/api/fleet-command", { commanderID: fleet.commander.characterID, action, args });
    toast(success || result.message, "good");
    await load();
    draw(false);
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    busy = false;
  }
}

// Listeners live on this page's own wrapper, which is replaced when another
// page is shown, so they never fire elsewhere.
function bind() {
  const view = $("fleets-page");
  if (!view) return;
  view.addEventListener("click", async (event) => {
    const fleet = data && data.fleets.find((entry) => entry.fleetID === activeFleet);
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      activeFleet = Number(tab.dataset.tab);
      draw(true);
      return;
    }
    if (!fleet) return;
    if (event.target.matches("[data-pick], #fleet-pick-all")) return;
    const type = event.target.closest("[data-type]");
    if (type) {
      if (type.dataset.type !== fleet.doctrine.fleetType) await command(fleet, "set-type", { fleetType: type.dataset.type });
      return;
    }
    if (event.target.closest("#fleet-start")) {
      const picked = [...chosenFor(fleet)];
      await command(fleet, "start", picked.length ? { botIDs: picked } : {});
      return;
    }
    if (event.target.closest("#fleet-stop")) {
      const ok = await confirmDialog("Stand the fleet down?", "Every bot on duty recalls its drones and goes back to its own work. Ore already in their holds stays with them.", "Stand down", true);
      if (ok) await command(fleet, "stop");
      return;
    }
    if (event.target.closest("#fleet-release")) {
      const ok = await confirmDialog("Call in busy bots?", "Bots doing their own work stop it safely and join the fleet. Trades and industry jobs already underway finish first.", "Call them in");
      if (ok) await command(fleet, "release-work");
      return;
    }
    if (event.target.closest("#fleet-fit-apply")) {
      const value = Number($("fleet-fit-id").value);
      if (!Number.isInteger(value) || value <= 0) {
        toast("Type the number of a saved fitting.", "bad");
        return;
      }
      fitDraft[fleet.fleetID] = "";
      await command(fleet, "set-fit", { fleetType: fleet.doctrine.fleetType, fittingID: value });
      return;
    }
    const row = event.target.closest("[data-pilot]");
    if (row && !event.target.closest("input, button, a")) void openPilot(Number(row.dataset.pilot));
  });
  view.addEventListener("keydown", (event) => {
    const row = event.key === "Enter" && event.target.closest("[data-pilot]");
    if (row && event.target === row) void openPilot(Number(row.dataset.pilot));
  });
  view.addEventListener("change", async (event) => {
    const fleet = data && data.fleets.find((entry) => entry.fleetID === activeFleet);
    if (!fleet) return;
    if (event.target.matches("[data-fleet-fit]")) {
      await command(fleet, "set-fit", { fleetType: fleet.doctrine.fleetType, fittingID: Number(event.target.value) || 0 });
      return;
    }
    const picks = chosenFor(fleet);
    if (event.target.matches("[data-pick]")) {
      const id = Number(event.target.dataset.pick);
      if (event.target.checked) picks.add(id);
      else picks.delete(id);
      drawFleet(fleet);
      return;
    }
    if (event.target.id === "fleet-pick-all") {
      picks.clear();
      if (event.target.checked) for (const member of fleet.members) if (member.isBot) picks.add(member.characterID);
      drawFleet(fleet);
    }
  });
  view.addEventListener("input", (event) => {
    if (event.target.matches("[data-fleet-fit-id]")) fitDraft[activeFleet] = event.target.value;
  });
}

function drawFleet(fleet) {
  replaceKeepingFocus($("fleet-body"), fleetPanel(fleet));
  const all = $("fleet-pick-all");
  const bots = fleet.members.filter((member) => member.isBot);
  const picks = chosenFor(fleet);
  if (all) {
    all.checked = bots.length > 0 && bots.every((bot) => picks.has(bot.characterID));
    all.indeterminate = picks.size > 0 && !all.checked;
  }
}

function draw(full) {
  if (!data.fleets.some((fleet) => fleet.fleetID === activeFleet)) activeFleet = data.fleets[0] ? data.fleets[0].fleetID : 0;
  const fleet = data.fleets.find((entry) => entry.fleetID === activeFleet);
  const tabs = document.querySelector("#fleets-page .tabs");
  if (!full && fleet && $("fleet-body") && Boolean(tabs) === data.fleets.length > 1) {
    if (tabs) tabs.outerHTML = tabsHtml();
    drawFleet(fleet);
    return;
  }
  $("view").innerHTML = pageHtml();
  if (fleet) drawFleet(fleet);
  bind();
}

async function load() {
  data = await getJSON("/api/fleets");
  data.fleets = Array.isArray(data.fleets) ? data.fleets : [];
  data.fleetTypes = Array.isArray(data.fleetTypes) ? data.fleetTypes : [];
}

export async function render(ctx) {
  if (ctx.fresh) {
    ctx.setCrumbs([{ label: "Fleets" }]);
    if (!data) $("view").innerHTML = `${pageHead("fleet", "Fleets", "Loading fleets…")}`;
  }
  // The shell's status, watch panel and search come from the summary.
  void ctx.loadSummary(false).catch(() => {});
  const hadPage = Boolean($("fleets-page"));
  const wanted = Number(ctx.param) || 0;
  if (ctx.fresh && wanted) activeFleet = wanted;
  await load();
  draw(ctx.fresh || !hadPage);
}
