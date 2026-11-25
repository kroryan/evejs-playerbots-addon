// Reputation: how bot corporations answer violence. Attacks by other
// corporations' pilots become grievances; repeat attacks mark the aggressor
// hostile (gate campers shoot it in low and null) and then bring a war. Also
// the bots' security status, the game's karma. You can mark, declare or
// forgive by hand.

import { getJSON, postJSON } from "./api.js";
import { $, esc, num, toast, pageHead, emptyState, notice, rel, icon } from "./ui.js";

let data = null;
let busy = false;

async function load() {
  data = await getJSON("/api/reputation");
}

function statusTag(row) {
  if (row.atWar) return `<span class="pill bad">${icon("target", { size: 13 })}At war${row.warID ? ` #${num(row.warID)}` : ""}</span>`;
  if (row.manual === "war") return `<span class="pill bad">War ordered</span>`;
  if (row.hostile) return `<span class="pill warn">Hostile${row.manual === "hostile" ? " (by hand)" : ""}</span>`;
  if (row.manual === "clear") return `<span class="pill">Forgiven</span>`;
  return `<span class="pill">Watching</span>`;
}

function corp(entry) {
  return `<strong>${esc(entry.name)}</strong>${entry.ticker ? ` <span class="muted">[${esc(entry.ticker)}]</span>` : ""}`;
}

function actions(row) {
  const ids = `data-corp="${row.victim.corporationID}" data-target="${row.aggressor.corporationID}"`;
  return [
    !row.hostile && !row.atWar ? `<button type="button" class="btn small" data-rep="hostile" ${ids}>Mark hostile</button>` : "",
    !row.atWar ? `<button type="button" class="btn small danger" data-rep="war" ${ids}>Declare war</button>` : "",
    row.hostile || row.manual ? `<button type="button" class="btn small" data-rep="clear" ${ids}>Forgive</button>` : "",
  ].join(" ");
}

function grievanceTable() {
  if (!data.grievances.length) return emptyState("shield", "No grievances", "Nobody has attacked a bot corporation's pilots yet.");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Bot corporation</th><th>Aggressor</th><th>Attacks today</th><th>All time</th><th>Status</th><th>Last attack</th><th></th></tr></thead>
    <tbody>${data.grievances.map((row) => `<tr>
      <td>${corp(row.victim)}</td>
      <td>${corp(row.aggressor)}${row.byPerson ? ` <span class="pill">People</span>` : ""}</td>
      <td>${num(row.incidentsToday)}</td><td>${num(row.total)}</td>
      <td>${statusTag(row)}</td><td>${row.lastAt ? esc(rel(row.lastAt)) : "—"}</td>
      <td class="row-actions">${actions(row)}</td></tr>`).join("")}</tbody></table></div>`;
}

function securityList(title, rows, empty) {
  return `<div class="panel"><div class="panel-head"><h2>${title}</h2></div><div class="panel-body">${rows.length
    ? `<ul class="plain-list">${rows.map((row) => `<li><span>${esc(row.name)}</span> <span class="pill ${row.securityStatus < -2 ? "bad" : row.securityStatus < 0 ? "warn" : "good"}">${row.securityStatus.toFixed(2)}</span></li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`}</div></div>`;
}

function draw() {
  const rules = data.rules || {};
  $("view").innerHTML = `${pageHead("shield", "Reputation", "Who attacked whom, who is hostile, and the bots' security status")}
    ${notice(`A corporation whose pilots are attacked ${num(rules.hostileAfter)} times in ${num(rules.windowHours)} hours marks the aggressor hostile for ${num(rules.hostileDays)} days; ${num(rules.warAfter)} attacks bring a war declaration (it needs a structure as war headquarters). Security pilots camp their headquarters' gates against war targets, criminals and, in low and null security space, hostile corporations.`, "info")}
    <div class="panel"><div class="panel-head"><h2>Grievances</h2></div>${grievanceTable()}</div>
    <div class="rep-grid">${securityList("Outlaws (negative security status)", data.outlaws || [], "No bot has a negative security status.")}
    ${securityList("Upstanding pilots", data.paragons || [], "No bot has a high security status yet.")}</div>`;
  for (const button of document.querySelectorAll("[data-rep]")) {
    button.addEventListener("click", () => command(button.dataset.rep, Number(button.dataset.corp), Number(button.dataset.target)));
  }
}

async function command(action, corporationID, targetCorporationID) {
  if (busy) return;
  busy = true;
  try {
    const result = await postJSON("/api/reputation-command", { action, corporationID, targetCorporationID });
    toast(result.message || "Done.", result.success === false ? "bad" : "good");
    await load();
    draw();
  } catch (error) {
    toast(String(error && error.message || error), "bad");
  } finally {
    busy = false;
  }
}

export async function render(ctx) {
  if (ctx.fresh) {
    ctx.setCrumbs([{ label: "Reputation" }]);
    if (!data) $("view").innerHTML = pageHead("shield", "Reputation", "Loading…");
  }
  void ctx.loadSummary(false).catch(() => {});
  await load();
  draw();
}
