// Pilot list shared by the Activity and Corporation pages: filters, state
// chips, paging, optional row selection, and a click to open the pilot drawer.

import { getJSON } from "./api.js";
import { esc, num, pilotCell, stateTag, when, pager, replaceKeepingFocus, icon, emptyState, toast, STATE_ORDER, STATE_LABELS } from "./ui.js";
import { openPilot } from "./drawer.js";
import { downloadCSV, fetchAll, stamp } from "./csv.js";

export function createRoster(options = {}) {
  return {
    page: 0,
    pageSize: 50,
    search: "",
    corporationID: options.corporationID || "",
    specialty: "",
    states: new Set(),
    activity: "",
    reason: "",
    selectable: Boolean(options.selectable),
    selected: new Set(),
    rows: [],
    total: 0,
    error: "",
    lockedCorporation: Boolean(options.corporationID),
  };
}

function filterQuery(roster) {
  const query = new URLSearchParams({ sort: "state" });
  if (roster.search) query.set("search", roster.search);
  if (roster.corporationID) query.set("corporationID", String(roster.corporationID));
  if (roster.specialty) query.set("specialty", roster.specialty);
  if (roster.states.size) query.set("state", [...roster.states].join(","));
  if (roster.activity) query.set("activity", roster.activity);
  if (roster.reason) query.set("reason", roster.reason);
  return query;
}

async function exportRoster(roster, button) {
  button.disabled = true;
  try {
    const rows = await fetchAll("/api/bots", filterQuery(roster));
    downloadCSV(`playerbots-pilots-${stamp()}.csv`, [
      { label: "Character ID", value: (r) => r.characterID },
      { label: "Pilot", value: (r) => r.characterName },
      { label: "Corporation", value: (r) => r.corporationName },
      { label: "Ticker", value: (r) => r.corporationTicker },
      { label: "Specialty", value: (r) => r.specialty },
      { label: "State", value: (r) => r.stateLabel || r.state },
      { label: "Doing", value: (r) => r.doing },
      { label: "Reason", value: (r) => r.reason },
      { label: "Where", value: (r) => r.where },
      { label: "Security", value: (r) => r.security },
      { label: "Ship", value: (r) => r.shipName },
      { label: "Online", value: (r) => (r.connected ? "yes" : "no") },
      { label: "Paused", value: (r) => (r.paused ? "yes" : "no") },
      { label: "Since", value: (r) => r.since },
    ], rows);
    toast(`Downloaded ${num(rows.length)} pilot${rows.length === 1 ? "" : "s"} as CSV.`, "good");
  } catch (error) {
    toast(`Could not export: ${error.message}`, "bad");
  } finally {
    button.disabled = false;
  }
}

export async function loadRoster(roster) {
  const query = new URLSearchParams({ offset: String(roster.page * roster.pageSize), limit: String(roster.pageSize), sort: "state" });
  if (roster.search) query.set("search", roster.search);
  if (roster.corporationID) query.set("corporationID", String(roster.corporationID));
  if (roster.specialty) query.set("specialty", roster.specialty);
  if (roster.states.size) query.set("state", [...roster.states].join(","));
  if (roster.activity) query.set("activity", roster.activity);
  if (roster.reason) query.set("reason", roster.reason);
  try {
    const data = await getJSON(`/api/bots?${query}`);
    roster.rows = data.rows || [];
    roster.total = Number(data.total) || 0;
    roster.error = "";
    const pages = Math.max(1, Math.ceil(roster.total / roster.pageSize));
    if (roster.page >= pages && roster.page > 0) {
      roster.page = pages - 1;
      return loadRoster(roster);
    }
  } catch (error) {
    roster.error = error.message;
  }
  return roster;
}

export function filterDescription(roster, labels = {}) {
  const parts = [];
  if (roster.states.size) parts.push([...roster.states].map((s) => STATE_LABELS[s] || s).join(" or "));
  if (roster.activity) parts.push(labels.activity || roster.activity);
  if (roster.reason) parts.push(labels.reason || roster.reason);
  if (roster.search) parts.push(`“${roster.search}”`);
  return parts.join(" · ");
}

export function rosterHtml(roster, options = {}) {
  roster.lastOptions = options;
  const { corporations = [], specialties = [], labels = {}, selectionActions = "" } = options;
  const allOnPage = roster.rows.length > 0 && roster.rows.every((row) => roster.selected.has(row.characterID));
  const filterText = filterDescription(roster, labels);
  return `
  <div class="panel-head">
    <div><h2>${icon("users")}Pilots</h2><p>${num(roster.total)} ${filterText ? `matching ${esc(filterText)}` : "pilots"}</p></div>
    <div class="toolbar">
      <input class="field" type="search" data-roster="search" placeholder="Search name or ID" value="${esc(roster.search)}" aria-label="Search pilots by name or ID">
      ${roster.lockedCorporation ? "" : `<select class="field" data-roster="corporation" aria-label="Corporation"><option value="">All corporations</option>${corporations.map((c) => `<option value="${c.corporationID}"${String(c.corporationID) === String(roster.corporationID) ? " selected" : ""}>${esc(c.corporationName)}</option>`).join("")}</select>`}
      <select class="field" data-roster="specialty" aria-label="Specialty"><option value="">All specialties</option>${specialties.map((s) => `<option value="${esc(s)}"${s === roster.specialty ? " selected" : ""}>${esc(s)}</option>`).join("")}</select>
      ${filterText || roster.specialty || (!roster.lockedCorporation && roster.corporationID) ? `<button class="btn small ghost" type="button" data-roster="clear">${icon("close", { size: 16 })}<span>Clear filters</span></button>` : ""}
      <button class="btn small" type="button" data-roster="export" title="Download every pilot matching these filters">${icon("download", { size: 16 })}<span>CSV</span></button>
    </div>
  </div>
  <div class="panel-body" style="padding-bottom:10px"><div class="chips">${STATE_ORDER.map((s) => `<button type="button" class="chip${roster.states.has(s) ? " on" : ""}" data-roster-state="${s}" aria-pressed="${roster.states.has(s)}"><span class="swatch bg-${s}"></span>${esc(STATE_LABELS[s])}</button>`).join("")}</div></div>
  ${roster.selectable && roster.selected.size ? `<div class="selection"><strong>${num(roster.selected.size)} selected</strong>${selectionActions}<button class="btn small ghost" type="button" data-roster="unselect">${icon("close", { size: 16 })}<span>Clear selection</span></button></div>` : ""}
  ${roster.error ? `<div class="notice error" style="margin:0 16px 10px">${icon("alert")}<div>${esc(roster.error)}</div></div>` : ""}
  <div class="table-wrap"><table>
    <thead><tr>${roster.selectable ? `<th style="width:34px"><input type="checkbox" data-roster="all" ${allOnPage ? "checked" : ""} aria-label="Select all on this page"></th>` : ""}<th>Pilot</th><th>State</th><th>Doing</th><th>Where</th><th>Since</th></tr></thead>
    <tbody>${roster.rows.map((row) => `<tr class="clickable${roster.selected.has(row.characterID) ? " selected" : ""}" data-pilot="${row.characterID}">
      ${roster.selectable ? `<td class="select-cell"><input type="checkbox" data-select="${row.characterID}" ${roster.selected.has(row.characterID) ? "checked" : ""} aria-label="Select ${esc(row.characterName)}"></td>` : ""}
      <td>${pilotCell(row)}</td>
      <td>${stateTag(row.state, row.stateLabel)}</td>
      <td><strong>${esc(row.doing)}</strong>${row.reason ? `<span class="sub" title="${esc(row.reason)}">${esc(row.reason)}</span>` : ""}</td>
      <td>${esc(row.where)}${row.shipName ? `<span class="sub">${esc(row.shipName)}</span>` : ""}</td>
      <td class="nowrap">${row.retryAt ? `retry ${when(row.retryAt)}` : when(row.since)}</td>
    </tr>`).join("")}</tbody>
  </table></div>
  ${roster.rows.length ? "" : emptyState(roster.error ? "alert" : "users", roster.error ? "Could not load pilots" : "No pilots match these filters", roster.error ? "" : filterText ? "Try clearing a filter." : "Pilots appear here once the roster is seeded.")}
  ${pager(roster.page, roster.pageSize, roster.total, "roster")}`;
}

// Wires events inside `root`. rerender(true) reloads pilots from the server;
// selection changes only redraw the list in place.
export function bindRoster(root, roster, rerender) {
  const redraw = () => replaceKeepingFocus(root, rosterHtml(roster, roster.lastOptions || {}));
  let searchTimer = null;
  root.addEventListener("input", (event) => {
    if (event.target.dataset.roster !== "search") return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { roster.search = event.target.value.trim(); roster.page = 0; void rerender(true); }, 350);
  });
  root.addEventListener("change", (event) => {
    const target = event.target;
    if (target.dataset.roster === "corporation") { roster.corporationID = target.value; roster.page = 0; void rerender(true); }
    else if (target.dataset.roster === "specialty") { roster.specialty = target.value; roster.page = 0; void rerender(true); }
    else if (target.dataset.roster === "all") {
      for (const row of roster.rows) target.checked ? roster.selected.add(row.characterID) : roster.selected.delete(row.characterID);
      redraw();
    } else if (target.dataset.select) {
      const id = Number(target.dataset.select);
      target.checked ? roster.selected.add(id) : roster.selected.delete(id);
      redraw();
    }
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest("input, select, a")) return;
    const cell = target.closest(".select-cell");
    if (cell) { cell.querySelector("input").click(); return; }
    const stateChip = target.closest("[data-roster-state]");
    if (stateChip) {
      const state = stateChip.dataset.rosterState;
      roster.states.has(state) ? roster.states.delete(state) : roster.states.add(state);
      roster.page = 0;
      return void rerender(true);
    }
    const control = target.closest("[data-roster]");
    if (control && control.dataset.roster === "clear") {
      roster.states.clear(); roster.activity = ""; roster.reason = ""; roster.search = ""; roster.specialty = "";
      if (!roster.lockedCorporation) roster.corporationID = "";
      roster.page = 0;
      return void rerender(true);
    }
    if (control && control.dataset.roster === "unselect") { roster.selected.clear(); return redraw(); }
    if (control && control.dataset.roster === "export") return void exportRoster(roster, control);
    const pageButton = target.closest("[data-page]");
    if (pageButton && pageButton.dataset.page.startsWith("roster:")) {
      roster.page = Math.max(0, roster.page + (pageButton.dataset.page.endsWith("next") ? 1 : -1));
      return void rerender(true);
    }
    const row = target.closest("[data-pilot]");
    if (row && !target.closest("button, .select-cell")) openPilot(Number(row.dataset.pilot), () => rerender(true));
  });
}
