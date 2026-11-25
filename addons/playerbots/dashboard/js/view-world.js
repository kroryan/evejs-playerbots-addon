// World: where pilots are (systems), fleets, wars, structures and
// sovereignty (territory), and combat (killboard).

import { getJSON } from "./api.js";
import { $, esc, num, isk, stat, emptyRow, security, corpLogo, pageHead, icon, notice } from "./ui.js";

let killboard = null;
let killboardAt = 0;

function tabs(active) {
  const items = [["systems", "Systems", "map-pin"], ["territory", "Territory", "flag"], ["killboard", "Killboard", "target"]];
  return `<nav class="tabs" aria-label="World sections">${items.map(([id, label, iconName]) => `<a href="#world${id === "systems" ? "" : `/${id}`}" class="${id === active ? "active" : ""}"${id === active ? ' aria-current="page"' : ""}>${icon(iconName, { size: 18 })}${label}</a>`).join("")}</nav>`;
}

function systemsHtml(summary) {
  const systems = summary.systems || [];
  const total = Number(summary.roster?.total) || 1;
  const limit = Number(summary.systemCapacity?.autonomousBotsPerSystem) || 0;
  const over = systems.filter((s) => s.overAutonomousLimit);
  return `${limit ? notice(`Per-system limit: <strong>${num(limit)}</strong> autonomous pilots. It stops pilots entering space in a full system and makes the director move residents out when it assigns them work. Seeding places new pilots in their race's starter system without checking it, so starter systems can run over while work is off.${over.length ? ` <strong>${num(over.length)} systems are over the limit now.</strong>` : ""}`, "info") : ""}
  <div class="panel"><div class="panel-head"><div><h2>${icon("map-pin")}${num(systems.length)} systems with pilots</h2><p>Where each pilot was last recorded, docked or in space</p></div></div>
  <div class="table-wrap"><table><thead><tr><th>System</th><th>Security</th><th class="num">Pilots</th><th>Share of roster</th><th></th></tr></thead><tbody>
  ${systems.map((s) => `<tr><td><strong>${esc(s.systemName)}</strong><span class="sub mono">${esc(s.systemID)}</span></td><td>${security(s.security)}</td><td class="num">${num(s.botCount)}</td>
    <td><span class="bar${s.overAutonomousLimit ? " over" : ""}"><i style="width:${Math.max(2, Math.round(s.botCount * 100 / total))}%"></i></span> <span class="muted">${(s.botCount * 100 / total).toFixed(1)}%</span></td>
    <td>${s.overAutonomousLimit ? `<span class="state warn">${num(s.botCount - limit)} over limit</span>` : ""}</td></tr>`).join("") || emptyRow(5, "No pilot locations yet.")}
  </tbody></table></div></div>`;
}

function territoryHtml(summary) {
  const a = summary.activity || {};
  const t = summary.territory || {};
  const fleets = t.fleets || [];
  const wars = t.wars || [];
  const structures = t.structures || [];
  const sov = t.sovereignty || [];
  const systemName = new Map((summary.systems || []).map((s) => [Number(s.systemID), s.systemName]));
  return `<div class="stats">${stat("Fleets", num(a.fleets), `${num(a.botFleetMembers)} pilots · ${num(a.humanFleetMembers)} humans`, "cyan", "users")}${stat("Wars", num(a.activeWars), "active or ending", "red", "target")}${stat("Structures", num(a.structures), `${num(a.lowPowerStructures)} low power · ${num(a.structuresMissingQuantumCore)} without core`, "amber", "corporations")}${stat("Sovereign systems", num(a.claimedSystems), "", "violet", "flag")}</div>
  <div class="panel"><div class="panel-head"><h2>${icon("users")}Fleets</h2></div><div class="table-wrap"><table><thead><tr><th>Fleet</th><th class="num">Members</th><th class="num">Bots</th><th class="num">Humans</th><th>System</th></tr></thead><tbody>
    ${fleets.map((f) => `<tr><td><strong>${esc(f.name)}</strong></td><td class="num">${num(f.memberCount)}</td><td class="num">${num(f.botMembers)}</td><td class="num">${num(f.humanMembers)}</td><td>${esc(systemName.get(Number(f.solarSystemID)) || (f.solarSystemID ? `System ${f.solarSystemID}` : "—"))}</td></tr>`).join("") || emptyRow(5, "No active fleets.")}</tbody></table></div></div>
  <div class="panel"><div class="panel-head"><h2>${icon("target")}Wars</h2></div><div class="table-wrap"><table><thead><tr><th>Attacker</th><th>Defender</th><th>Status</th><th>Type</th></tr></thead><tbody>
    ${wars.map((w) => `<tr><td><strong>${esc(w.declaredByName)}</strong></td><td><strong>${esc(w.againstName)}</strong></td><td><span class="state ${w.status === "active" ? "bad" : w.status === "ending" ? "warn" : "idle"}">${esc(w.status)}</span></td><td>${w.mutual ? "Mutual" : "Declared"}</td></tr>`).join("") || emptyRow(4, "No wars.")}</tbody></table></div></div>
  <div class="panel"><div class="panel-head"><h2>${icon("corporations")}Upwell structures</h2></div><div class="table-wrap"><table><thead><tr><th>Structure</th><th>System</th><th>Power</th><th>Core</th><th>State</th></tr></thead><tbody>
    ${structures.map((s) => `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.solarSystemName || "—")}</td><td><span class="state ${s.upkeep === "full_power" ? "good" : s.upkeep === "low_power" ? "warn" : "bad"}">${esc(String(s.upkeep).replaceAll("_", " "))}</span></td><td>${s.hasQuantumCore ? "Installed" : '<span class="muted">Missing</span>'}</td><td>${esc(String(s.state).replaceAll("_", " "))}</td></tr>`).join("") || emptyRow(5, "No structures.")}</tbody></table></div></div>
  <div class="panel"><div class="panel-head"><h2>${icon("flag")}Sovereignty</h2></div><div class="table-wrap"><table><thead><tr><th>System</th><th>Alliance</th></tr></thead><tbody>
    ${sov.map((s) => `<tr><td><strong>${esc(s.solarSystemName)}</strong></td><td>${esc(s.allianceName)}</td></tr>`).join("") || emptyRow(2, "No sovereignty claims.")}</tbody></table></div></div>`;
}

function side(category) {
  const c = String(category || "other").toLowerCase();
  const label = { playerbot: "Playerbot", player: "Capsuleer", npc: "NPC", structure: "Structure" }[c] || "Unknown";
  return `<span class="side ${esc(c)}">${label}</span>`;
}

function shipIcon(typeID) {
  const id = Math.trunc(Number(typeID));
  return id > 0 ? `<img src="/api/ship-render?typeID=${id}&amp;size=64" alt="" loading="lazy">` : "";
}

function killboardHtml(data) {
  const recent = data.recent || [];
  return `<div class="stats">${stat("Killmails", num(data.total), `${num(data.day)} in 24 h · ${num(data.week)} in 7 days`, "cyan", "target")}${stat("Playerbot losses", num(data.playerbotDeaths), `${num(data.playerbotFinalBlows)} playerbot final blows`, "amber", "ship")}${stat("NPC losses", num(data.npcDeaths), `${num(data.npcFinalBlows)} NPC final blows`, "violet", "shield")}${stat("Capsuleer losses", num(data.playerDeaths), `${num(data.pods)} pods`, "red", "user")}</div>
  <div class="panel"><div class="panel-head"><div><h2>${icon("target")}Latest kills</h2><p>NPCs can fly capsuleer hulls; the side comes from the pilot, not the ship</p></div></div><div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Victim</th><th>Ship</th><th>System</th><th>Final blow</th><th class="num">Lost</th></tr></thead><tbody>
    ${recent.map((k) => `<tr><td class="nowrap">${esc(k.time ? new Date(k.time).toLocaleString() : "—")}</td>
      <td>${side(k.victimCategory)} <strong>${esc(k.victimName)}</strong><span class="sub">${esc(k.victimCorporationName || "")}</span></td>
      <td><div class="kill-ship">${shipIcon(k.victimShipTypeID)}<span>${esc(k.victimShipName)}</span></div></td>
      <td>${esc(k.systemName)}</td>
      <td>${side(k.finalCategory)} <strong>${esc(k.finalName)}</strong><span class="sub">${esc(k.finalCorporationName || "")}</span></td>
      <td class="num">${esc(isk(k.iskLost))}</td></tr>`).join("") || emptyRow(6, "No killmails yet.")}</tbody></table></div></div>
  <div class="grid-2">
    <div class="panel"><div class="panel-head"><h2>${icon("users")}Playerbot pilots</h2></div><div class="table-wrap"><table><thead><tr><th>Pilot</th><th class="num">Kills</th><th class="num">Losses</th></tr></thead><tbody>
      ${(data.pilots || []).map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="num">${num(p.kills)}</td><td class="num">${num(p.losses)}</td></tr>`).join("") || emptyRow(3, "None yet.")}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h2>${icon("corporations")}Corporations</h2></div><div class="table-wrap"><table><thead><tr><th>Corporation</th><th class="num">Kills</th><th class="num">NPC kills</th><th class="num">Losses</th></tr></thead><tbody>
      ${(data.corporations || []).map((c) => `<tr><td>${corpLogo(c.corporationID, 16, "corp-logo inline")}<strong>${esc(c.name)}</strong></td><td class="num">${num(c.kills)}</td><td class="num">${num(c.npcKills)}</td><td class="num">${num(c.losses)}</td></tr>`).join("") || emptyRow(4, "None yet.")}</tbody></table></div></div>
  </div>
  <div class="panel"><div class="panel-head"><h2>${icon("ship")}Most destroyed ships</h2></div><div class="table-wrap"><table><thead><tr><th>Ship</th><th class="num">Lost</th></tr></thead><tbody>
    ${(data.ships || []).map((s) => `<tr><td><div class="kill-ship">${shipIcon(s.typeID)}<span>${esc(s.name)}</span></div></td><td class="num">${num(s.lost)}</td></tr>`).join("") || emptyRow(2, "None yet.")}</tbody></table></div></div>`;
}

export async function render(ctx) {
  const tab = ["territory", "killboard"].includes(ctx.param) ? ctx.param : "systems";
  ctx.setCrumbs([{ label: "World", href: "#world" }, { label: tab[0].toUpperCase() + tab.slice(1) }]);
  const summary = await ctx.loadSummary(false);
  let body;
  if (tab === "killboard") {
    if (!killboard || ctx.fresh || Date.now() - killboardAt > 30_000) {
      killboard = await getJSON("/api/kills");
      killboardAt = Date.now();
    }
    body = killboardHtml(killboard);
  } else {
    body = tab === "territory" ? territoryHtml(summary) : systemsHtml(summary);
  }
  $("view").innerHTML = `${pageHead("world", "World", "Where pilots are, what they hold, and who they fight.")}${tabs(tab)}${body}`;
  $("view").querySelectorAll("img").forEach((img) => img.addEventListener("error", () => { img.hidden = true; }, { once: true }));
}
