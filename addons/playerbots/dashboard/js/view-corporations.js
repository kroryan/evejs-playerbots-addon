// Corporations: list of bot corporations and a detail page per corporation
// with its HQ, orders, priorities, roster and command log.

import { getJSON, postJSON, corpCommand, botCommand } from "./api.js";
import { $, esc, num, stateBar, stateTag, when, toast, confirmDialog, coalesce, replaceKeepingFocus, corpLogo, corporationLogos, hasCorporationLogo, setCorporationLogos, pageHead, icon, emptyState, notice, skeleton, STATE_ORDER, STATE_LABELS } from "./ui.js";
import { remember } from "./prefs.js";
import { createRoster, loadRoster, rosterHtml, bindRoster } from "./roster.js";

let ctxRef = null;
let listSort = "size";
let detail = null;
let roster = null;
let priorityDraft = null;
let priorityDirty = false;
let hqDraft = "";
let workMode = "auto";
let workTrips = 1;
let listFilter = "";
let detailTab = "overview";

function statesFor(counts = {}) {
  return STATE_ORDER.map((id) => ({ id, label: STATE_LABELS[id], count: Number(counts[id]) || 0 }));
}

// ------------------------------------------------------------------ list

function corpAvatar(c, size = 40) {
  return corpLogo(c.corporationID, size) || `<span class="corp-logo ph" style="width:${size}px;height:${size}px">${esc((c.ticker || "?").slice(0, 3))}</span>`;
}

function listRows(corps) {
  return corps.map((c) => `<tr class="clickable" data-corp="${c.corporationID}" tabindex="0">
      <td><div class="corp-name">${corpAvatar(c)}<span><strong>${esc(c.corporationName)}</strong> <span class="muted">[${esc(c.ticker)}]</span><span class="sub">${esc(c.allianceName || "No alliance")} · ${esc((c.specialties || []).join(", "))}</span></span></div></td>
      <td class="num"><strong>${num(c.botCount)}</strong><span class="sub">${num(c.memberCount)} / ${c.memberLimit ? num(c.memberLimit) : "∞"} members</span></td>
      <td style="min-width:180px">${stateBar(statesFor(c.stateCounts), { small: true })}<span class="sub">${STATE_ORDER.filter((s) => (c.stateCounts || {})[s]).map((s) => `${STATE_LABELS[s]} ${num(c.stateCounts[s])}`).join(" · ")}</span></td>
      <td>${c.topActivity ? `${esc(c.topActivity.label)} <span class="muted">${num(c.topActivity.count)}</span>` : `<span class="muted">—</span>`}</td>
      <td><div class="chips">${(c.priorities || []).map((p) => `<span class="chip">${esc(p.label)}</span>`).join("") || `<span class="muted">Default order</span>`}</div></td>
      <td>${c.held ? `<span class="state warn">Recalled to HQ</span>` : c.recalledPilots ? `<span class="state warn">${num(c.recalledPilots)} recalled</span>` : `<span class="muted">—</span>`}</td>
    </tr>`).join("");
}

async function renderList(fresh) {
  const summary = await ctxRef.loadSummary(false);
  if (fresh) ctxRef.setCrumbs([{ label: "Corporations" }]);
  const all = [...(summary.corporations || [])].filter((c) => c.botCount > 0);
  const words = listFilter.toLowerCase().split(/\s+/).filter(Boolean);
  const corps = all.filter((c) => words.every((word) => `${c.corporationName} ${c.ticker} ${c.allianceName || ""} ${(c.specialties || []).join(" ")}`.toLowerCase().includes(word)));
  const idle = (c) => { const s = c.stateCounts || {}; const total = Object.values(s).reduce((a, b) => a + b, 0) || 1; return ((s.idle || 0) + (s.paused || 0) + (s.standby || 0) + (s.cooling || 0)) / total; };
  corps.sort(listSort === "name" ? (a, b) => a.corporationName.localeCompare(b.corporationName)
    : listSort === "idle" ? (a, b) => idle(b) - idle(a) || b.botCount - a.botCount
      : (a, b) => b.botCount - a.botCount || a.corporationName.localeCompare(b.corporationName));
  const table = `<div class="table-wrap"><table>
    <thead><tr><th>Corporation</th><th class="num">Pilots</th><th>What they are doing</th><th>Top job</th><th>Priorities</th><th>Orders</th></tr></thead>
    <tbody>${listRows(corps)}</tbody></table></div>
    ${corps.length ? "" : all.length ? emptyState("search", "No corporation matches", "Try another name or ticker.") : emptyState("corporations", "No bot corporations yet", "They are founded as the roster is seeded.")}`;
  if (!fresh && $("corp-list")) {
    $("corp-list").innerHTML = table;
    $("corp-count").textContent = `${num(all.length)} bot corporations · ${num(all.reduce((sum, c) => sum + c.botCount, 0))} pilots. Open one to see its pilots and give orders.`;
    return;
  }
  $("view").innerHTML = `
  ${pageHead("corporations", "Corporations", `<span id="corp-count">${num(all.length)} bot corporations · ${num(all.reduce((sum, c) => sum + c.botCount, 0))} pilots. Open one to see its pilots and give orders.</span>`)}
  <div class="panel">
    <div class="panel-head"><div class="toolbar">
      <input class="field" type="search" id="corp-filter" placeholder="Find a corporation, ticker or alliance" value="${esc(listFilter)}" aria-label="Find a corporation" style="min-width:280px">
      <select class="field" id="corp-sort" aria-label="Sort by"><option value="size"${listSort === "size" ? " selected" : ""}>Most pilots</option><option value="idle"${listSort === "idle" ? " selected" : ""}>Most not working</option><option value="name"${listSort === "name" ? " selected" : ""}>Name</option></select>
    </div></div>
    <div id="corp-list">${table}</div>
  </div>`;
  $("corp-sort").addEventListener("change", (event) => { listSort = event.target.value; void renderList(false); });
  $("corp-filter").addEventListener("input", (event) => { listFilter = event.target.value; void renderList(false); });
  const open = (row) => { if (row) location.hash = `#corporations/${row.dataset.corp}`; };
  $("corp-list").addEventListener("click", (event) => open(event.target.closest("[data-corp]")));
  $("corp-list").addEventListener("keydown", (event) => { if (event.key === "Enter") open(event.target.closest("[data-corp]")); });
}

// ---------------------------------------------------------------- detail

function orderLabel(o) {
  if (o.kind === "recall") {
    const who = o.scope === "selected" ? `${num(o.pilots || o.total)} selected pilot(s)` : "whole corporation";
    if (o.status === "running") return [`travelling`, `Recalling (${o.scope === "selected" ? "selected pilots" : "whole corporation"})`];
    if (o.status === "holding") return ["paused", `Holding at HQ: ${who}${o.released ? `, ${num(o.released)} released` : ""}`];
    if (o.status === "expired") return ["holding", `Recall timed out: ${who}`];
    return ["idle", `Recall ${o.status}: ${who}`];
  }
  if (o.status === "running") return ["working", `Work order: ${o.mode}`];
  return ["idle", `Work order saved (${o.mode}), ${num(o.pending)} pilot(s) still to start`];
}

function ordersHtml() {
  const orders = detail.orders || [];
  return `<div class="panel-head"><div><h2>${icon("bolt")}Orders</h2><p>For the whole corporation. Select pilots on the Pilots tab to order just them. Recall and work orders survive a server restart.</p></div></div>
  <div class="panel-body">
    <div class="actions">
      <button class="btn primary" type="button" data-corp-act="recall">${icon("home")}<span>Recall all to HQ</span></button>
      <button class="btn" type="button" data-corp-act="pause">${icon("pause")}<span>Pause all</span></button>
      <button class="btn" type="button" data-corp-act="resume">${icon("play")}<span>Resume all</span></button>
      ${orders.length ? `<button class="btn ghost" type="button" data-corp-act="cancel">${icon("close")}<span>Cancel orders</span></button>` : ""}
    </div>
    <div class="subform">
      <button class="btn primary" type="button" data-corp-act="work">${icon("briefcase")}<span>Send to work</span></button>
      <select class="field" data-corp-arg="mode" aria-label="Work mode">${[["auto", "Auto (by specialty)"], ["mine", "Mine"], ["pi", "PI setup"], ["director", "Hand back to director"]].map(([value, label]) => `<option value="${value}"${value === workMode ? " selected" : ""}>${label}</option>`).join("")}</select>
      <label class="muted">trips <input class="field" style="width:60px" type="number" min="1" max="20" value="${esc(workTrips)}" data-corp-arg="trips"></label>
    </div>
    <div class="order-rows">${orders.map((o) => `<div class="strip order-row">
      ${stateTag(...orderLabel(o))}
      ${o.status === "running" && o.total ? `<span><b>${num(o.done)}</b> of <b>${num(o.total)}</b> done</span>` : ""}
      ${o.status !== "running" && o.held ? `<span><b>${num(o.held)}</b> docked and held</span>` : ""}
      ${o.status === "running" && o.pending ? `<span><b>${num(o.pending)}</b> pending</span>` : ""}
      ${o.failed ? `<span><b>${num(o.failed)}</b> failed${o.failures ? ` (${esc(o.failures)})` : ""}</span>` : ""}
      ${o.destination ? `<span>to ${esc(o.destination)}</span>` : ""}
      ${o.startedAt ? `<span>ordered ${when(o.startedAt)}</span>` : ""}
    </div>`).join("") || `<p class="muted" style="margin:4px 0 0">No orders in force. The director decides what these pilots do${detail.autowork && detail.autowork.enabled === false ? " (autonomous work is off server-wide)" : ""}.</p>`}</div>
  </div>`;
}

function hqHtml() {
  const hq = detail.headquarters || {};
  const c = detail.corporation;
  const candidates = detail.headquartersCandidates || [];
  return `<div class="panel-head"><div><h2>${icon("home")}Headquarters</h2><p>Where recalls go and work starts from</p></div></div>
  <div class="panel-body">
    ${hq.error ? notice(esc(hq.error), "error") : `<p style="margin:0 0 4px"><strong>${esc(hq.name || `${hq.kind} ${hq.stationID}`)}</strong></p><p class="muted" style="margin:0">${esc(hq.kind === "structure" ? "Corporation structure" : "NPC station")} in ${esc(hq.systemName || `system ${hq.systemID}`)}${hq.saved ? " · set from the dashboard or chat" : " · the corporation's own HQ"}</p>`}
    <div class="subform">
      ${candidates.length ? `<select class="field" data-hq="pick"><option value="">Choose a corporation structure…</option>${candidates.map((s) => `<option value="${s.structureID}"${s.dockingOnline ? "" : " disabled"}>${esc(s.name)} · ${esc(s.systemName || s.solarSystemID)}${s.dockingOnline ? "" : " (no docking)"}</option>`).join("")}</select>` : ""}
      <input class="field" type="number" min="1" placeholder="or station / structure ID" data-hq="id" style="width:200px" value="${esc(hqDraft)}">
      <button class="btn" type="button" data-hq="set">${icon("map-pin")}<span>Set HQ</span></button>
      ${detail.savedHeadquartersID ? `<button class="btn ghost" type="button" data-hq="clear">Use the corporation's own HQ${c.homeStationName ? ` (${esc(c.homeStationName)})` : ""}</button>` : ""}
    </div>
    ${detail.deposit ? `<h3 class="section-label">Mining and PI output</h3>
      <p style="margin:0 0 8px"><strong>${detail.deposit.enabled ? `Deposited to ${esc(detail.deposit.label)}` : "Sold on the market"}</strong> <span class="muted">${detail.deposit.explicit ? "(set by hand)" : "(automatic)"}</span></p>
      <div class="subform"><select class="field" data-deposit="mode" aria-label="Change where output goes"><option value="">Change where it goes…</option><option value="on">Deposit at HQ</option><option value="off">Sell</option><option value="auto">Automatic</option><option value="hangar">Deposit to one hangar division…</option><option value="deliveries">Deposit to Corporation Deliveries (not visible in EveJS)</option></select>
      <label class="muted">division <input class="field" type="number" min="1" max="7" value="${detail.deposit.division || 1}" data-deposit="division" style="width:60px"></label></div>` : ""}
  </div>`;
}

function prioritiesHtml(options) {
  const draft = priorityDraft;
  const labels = new Map(options.map((o) => [String(o.id), o.label]));
  const completed = new Map((detail.corporation.priorities || []).map((p) => [String(p.id), p.completedTasks]));
  const unused = options.filter((o) => !draft.includes(String(o.id)));
  const changed = JSON.stringify(draft) !== JSON.stringify((detail.corporation.priorityIDs || []).map(String));
  return `<div class="panel-head"><div><h2>${icon("flag")}Priorities</h2><p>The director serves this corporation's pilots in this order</p></div>${changed ? `<button class="btn primary small" type="button" data-prio="save">${icon("check", { size: 16 })}<span>Save priorities</span></button>` : ""}</div>
  <div class="panel-body">
    ${draft.map((id, index) => `<div class="prio-row"><span class="prio-index">${index + 1}</span><strong>${esc(labels.get(id) || id)}</strong><span class="muted num small">${num(completed.get(id) || 0)} done</span>
      <button class="btn small ghost" type="button" data-prio="up" data-index="${index}" ${index === 0 ? "disabled" : ""} aria-label="Move up" title="Move up">${icon("arrow-up", { size: 16 })}</button>
      <button class="btn small ghost" type="button" data-prio="down" data-index="${index}" ${index === draft.length - 1 ? "disabled" : ""} aria-label="Move down" title="Move down">${icon("arrow-down", { size: 16 })}</button>
      <button class="btn small ghost" type="button" data-prio="remove" data-index="${index}" aria-label="Remove" title="Remove">${icon("close", { size: 16 })}</button></div>`).join("") || `<p class="muted" style="margin:0 0 8px">None set: the director uses its normal order.</p>`}
    ${unused.length ? `<select class="field" data-prio="add" style="margin-top:10px" aria-label="Add a priority"><option value="">+ Add a priority…</option>${unused.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join("")}</select>` : ""}
  </div>`;
}

function selectionActions() {
  const b = (act, iconName, label) => `<button class="btn small" type="button" data-sel="${act}">${icon(iconName, { size: 16 })}<span>${label}</span></button>`;
  return [b("recall", "home", "Recall to HQ"), b("work", "briefcase", "Send to work"), b("pause", "pause", "Pause"), b("resume", "play", "Resume"),
    b("stop", "stop", "Stop operation"), b("mine", "ore", "Mine"), b("colony", "planet", "PI colony"), b("combat", "target", "Combat patrol"), b("upgrade", "upgrade", "Upgrade ship")].join("");
}

// ------------------------------------------------------------------ logo

let logoDraft = null;

function logoHtml(c) {
  const has = hasCorporationLogo(c.corporationID);
  const current = has
    ? `<div class="logo-preview">${corpLogo(c.corporationID, 128, "corp-logo xl")}<span class="muted">Current logo</span></div>`
    : `<div class="logo-preview"><span class="corp-logo xl ph">${esc((c.ticker || "?").slice(0, 3))}</span><span class="muted">No logo yet. The game shows the corporation's emblem.</span></div>`;
  const draft = logoDraft && logoDraft.corporationID === c.corporationID
    ? `<div class="logo-preview"><img class="corp-logo xl" src="${esc(logoDraft.preview)}" alt=""><span class="muted">New logo, not saved</span></div>`
    : "";
  const note = corporationLogos.inGame
    ? "Players see a new logo in game the next time they log in."
    : "Players only see it in game once the corporation-logo add-on (evejs-corporation-logos) is installed on the server. The dashboard shows it either way.";
  return `<div class="panel-head"><div><h2>${icon("image")}Logo</h2><p>A picture for this corporation, shown here and in game in place of its emblem</p></div>
    <span class="pill ${corporationLogos.inGame ? "good" : ""}">${icon(corporationLogos.inGame ? "check" : "info", { size: 16 })}${corporationLogos.inGame ? "In-game add-on installed" : "Dashboard only"}</span></div>
  <div class="panel-body">
    <div class="logo-row">${current}${draft}</div>
    <div class="actions">
      <label class="btn">${icon("image")}<span>Choose image…</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-logo="file" hidden></label>
      ${draft ? `<button class="btn primary" type="button" data-logo="save">${icon("check")}<span>Save logo</span></button><button class="btn" type="button" data-logo="discard">${icon("close")}<span>Discard</span></button>` : ""}
      ${has && !draft ? `<button class="btn danger" type="button" data-logo="remove">${icon("trash")}<span>Remove logo</span></button>` : ""}
    </div>
    <p class="muted small" style="margin-top:12px">PNG, JPEG, WebP or GIF. A square picture of at least 256 × 256 looks best; other shapes are centred on a transparent background. ${esc(note)}</p>
    <p class="small" style="margin-top:8px"><a href="https://github.com/ubermidas/evejs-corporation-logos" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600">${icon("external", { size: 14 })} About the corporation-logo add-on</a></p>
  </div>`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("This file is not an image the browser can open."));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Square PNGs at every logo size, largest first, each scaled from the one
// above it so small sizes stay sharp.
function logoSizes(image) {
  const sizes = [...(corporationLogos.sizes.length ? corporationLogos.sizes : [32, 64, 128, 256, 512, 1024])].sort((a, b) => b - a);
  const images = {};
  let source = image;
  let sourceWidth = image.naturalWidth || image.width;
  let sourceHeight = image.naturalHeight || image.height;
  let preview = "";
  for (const size of sizes) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const scale = Math.min(size / sourceWidth, size / sourceHeight);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    context.drawImage(source, Math.round((size - width) / 2), Math.round((size - height) / 2), width, height);
    const url = canvas.toDataURL("image/png");
    images[String(size)] = url.slice(url.indexOf(",") + 1);
    if (size === 256) preview = url;
    source = canvas;
    sourceWidth = size;
    sourceHeight = size;
  }
  const largest = images[String(sizes[0])] || "";
  if (largest.length * 0.75 > 2 * 1024 * 1024) throw new Error("This picture is too detailed: its 1024 × 1024 PNG is over 2 MB. Try a simpler image.");
  return { images, preview };
}

async function refreshLogos() {
  try {
    setCorporationLogos(await getJSON("/api/corporation-logos"));
  } catch {
    // An older server without logo support: keep what we have.
  }
}

function drawLogo() {
  if (detail && $("corp-logo")) $("corp-logo").innerHTML = logoHtml(detail.corporation);
}

function bindLogo() {
  $("corp-logo").addEventListener("change", async (event) => {
    if (event.target.dataset.logo !== "file") return;
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Choose an image smaller than 20 MB.");
      const { images, preview } = logoSizes(await loadImage(file));
      logoDraft = { corporationID: detail.corporation.corporationID, images, preview };
    } catch (error) {
      toast(error.message, "bad");
    }
    drawLogo();
  });
  $("corp-logo").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-logo]");
    if (!button) return;
    const c = detail.corporation;
    const action = button.dataset.logo;
    if (action === "discard") {
      logoDraft = null;
      return void drawLogo();
    }
    try {
      let result;
      if (action === "save" && logoDraft) {
        button.disabled = true;
        result = await postJSON("/api/corporation-logo", { corporationID: c.corporationID, images: logoDraft.images });
        logoDraft = null;
      } else if (action === "remove") {
        if (!(await confirmDialog("Remove logo", `Remove the logo of ${c.corporationName}? The game shows its emblem again after players next log in.`, "Remove logo"))) return;
        result = await postJSON("/api/corporation-logo", { corporationID: c.corporationID, remove: true });
      } else {
        return;
      }
      toast(result.message, "good");
    } catch (error) {
      toast(error.message, "bad");
    }
    await refreshLogos();
    await drawDetail(false);
  });
}

function logHtml() {
  const log = detail.log || [];
  return `<div class="panel-head"><div><h2>${icon("list")}Command log</h2><p>Orders from the dashboard and chat, newest first</p></div></div>
  ${log.length ? `<ul class="log">${log.map((row) => `<li><div class="log-meta">${when(row.at)} · ${esc(row.source)} · <strong>${esc(row.action)}</strong>${row.success === false ? ' <span class="state bad">Refused</span>' : ""}</div><div>${esc(row.message)}</div></li>`).join("")}</ul>` : emptyState("list", "No orders yet", "Orders from this page and from chat appear here.")}`;
}

function drawTabs() {
  if (!$("corp-tabs") || !detail) return;
  const c = detail.corporation;
  const tabs = [["overview", "Overview", "corporations", ""], ["pilots", "Pilots", "users", num(c.botCount)], ["logo", "Logo", "image", ""], ["log", "Command log", "list", num((detail.log || []).length)]];
  $("corp-tabs").innerHTML = tabs.map(([id, label, iconName, count]) => `<button type="button" data-tab="${id}" class="${id === detailTab ? "active" : ""}" aria-pressed="${id === detailTab}">${icon(iconName, { size: 18 })}${label}${count ? `<span class="tab-count">${count}</span>` : ""}</button>`).join("");
}

const drawDetail = coalesce(async (reloadRoster) => {
  const id = Number(ctxRef.param);
  const [summary, data] = await Promise.all([ctxRef.loadSummary(false), getJSON(`/api/corporation?corporationID=${id}`), reloadRoster ? loadRoster(roster) : null]);
  if (!$("corp-roster") || Number(ctxRef.param) !== id) return;
  detail = data;
  const c = data.corporation;
  if (!priorityDirty) priorityDraft = (c.priorityIDs || []).map(String);
  ctxRef.setCrumbs([{ label: "Corporations", href: "#corporations" }, { label: c.corporationName }]);
  remember({ href: `#corporations/${c.corporationID}`, label: `${c.corporationName} [${c.ticker}]`, kind: "corporation" });
  const working = Number((c.stateCounts || {}).working) || 0;
  $("corp-head").innerHTML = `<div class="corp-header">
      ${corpLogo(c.corporationID, 96, "corp-logo xl corp-avatar") || `<span class="corp-logo xl ph corp-avatar">${esc((c.ticker || "?").slice(0, 3))}</span>`}
      <div class="corp-header-text">
        <h1>${esc(c.corporationName)} <span class="ticker">${esc(c.ticker)}</span>${c.held ? `<span class="pill warn">${icon("home", { size: 15 })}Recalled to HQ</span>` : c.recalledPilots ? `<span class="pill warn">${icon("home", { size: 15 })}${num(c.recalledPilots)} pilot(s) recalled</span>` : ""}</h1>
        <div class="handle">${esc(c.allianceName || "No alliance")}</div>
        <div class="profile-line">
          <span>${icon("briefcase")}${esc((c.specialties || []).join(", ") || "No specialty")}</span>
          ${c.topActivity ? `<span>${icon("activity")}Top job: ${esc(c.topActivity.label)} (${num(c.topActivity.count)})</span>` : ""}
        </div>
      </div>
      <div class="corp-metrics"><div><b>${num(c.botCount)}</b><span>Pilots</span></div><div><b>${num(working)}</b><span>Working</span></div><div><b>${num(c.memberCount)}</b><span>of ${c.memberLimit ? num(c.memberLimit) : "∞"} members</span></div></div>
    </div>`;
  drawTabs();
  $("corp-status").innerHTML = `<div class="panel-head"><div><h2>${icon("layers")}What its pilots are doing</h2><p>Click a state to filter the pilot list</p></div>${c.topActivity ? `<span class="muted">Top job: <strong>${esc(c.topActivity.label)}</strong> (${num(c.topActivity.count)})</span>` : ""}</div><div class="panel-body">${stateBar(statesFor(c.stateCounts), { selected: [...roster.states] })}</div>`;
  $("corp-orders").innerHTML = ordersHtml();
  if (!$("corp-logo").contains(document.activeElement)) $("corp-logo").innerHTML = logoHtml(c);
  replaceKeepingFocus($("corp-hq"), hqHtml());
  $("corp-prio").innerHTML = prioritiesHtml(summary.corporationPriorityOptions || []);
  replaceKeepingFocus($("corp-roster"), rosterHtml(roster, { specialties: c.specialties || [], selectionActions: selectionActions() }));
  $("corp-log").innerHTML = logHtml();
});

async function runCorp(action, args, confirmText) {
  if (confirmText && !(await confirmDialog("Confirm order", confirmText, "Send order"))) return;
  try {
    const result = await corpCommand(detail.corporation.corporationID, action, args);
    toast(result.message, "good");
  } catch (error) {
    toast(error.message, "bad");
  }
  ctxRef.store.summaryAt = 0;
  await drawDetail(true);
}

async function runSelection(action) {
  const ids = [...roster.selected];
  if (!ids.length) return;
  const c = detail.corporation;
  if (action === "recall" || action === "work") {
    const args = { characterIDs: ids };
    let modeLabel = "";
    if (action === "work") {
      const mode = $("corp-orders").querySelector('[data-corp-arg="mode"]');
      args.mode = mode ? mode.value : "auto";
      args.trips = Number(($("corp-orders").querySelector('[data-corp-arg="trips"]') || {}).value) || 1;
      modeLabel = mode ? ` (${mode.selectedOptions[0].textContent})` : "";
    }
    return runCorp(action, args, action === "recall"
      ? `Recall ${num(ids.length)} selected pilot(s) of ${c.corporationName} to the HQ? They stop their work, dock there and stay paused until sent to work or resumed.`
      : `Send ${num(ids.length)} selected pilot(s) of ${c.corporationName} to work${modeLabel}? The mode and trips are taken from the Orders panel on the Overview tab.`);
  }
  const args = {};
  const labels = { pause: "Pause", resume: "Resume", stop: "Stop the current operation of", mine: "Start mining for", colony: "Start PI colony setup for", combat: "Start a combat patrol for", upgrade: "Start a ship upgrade for" };
  if (ids.length > 5 && !(await confirmDialog("Confirm order", `${labels[action] || action} ${num(ids.length)} pilots?`, "Send order"))) return;
  const result = await botCommand(ids, action, args);
  toast(result.message, result.ok ? "good" : "bad");
  ctxRef.store.summaryAt = 0;
  await drawDetail(true);
}

async function renderDetail(fresh) {
  if (fresh || !$("corp-roster")) {
    const id = Number(ctxRef.param);
    if (!roster || Number(roster.corporationID) !== id) {
      roster = createRoster({ corporationID: id, selectable: true });
      priorityDraft = null;
      priorityDirty = false;
      hqDraft = "";
    }
    $("view").innerHTML = `<div id="corp-head">${skeleton(1)}</div>
      <nav class="tabs" id="corp-tabs" aria-label="Corporation sections"></nav>
      <div class="corp-tabs" id="corp-sections" data-active="${esc(detailTab)}">
        <div class="tab-overview"><div id="corp-status" class="panel"></div>
          <div class="grid-2 top"><div id="corp-orders" class="panel"></div><div id="corp-hq" class="panel"></div></div>
          <div id="corp-prio" class="panel"></div></div>
        <div class="tab-pilots"><div id="corp-roster" class="panel"></div></div>
        <div class="tab-logo"><div id="corp-logo" class="panel"></div></div>
        <div class="tab-log"><div id="corp-log" class="panel"></div></div>
      </div>`;
    $("corp-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]");
      if (!tab) return;
      detailTab = tab.dataset.tab;
      $("corp-sections").dataset.active = detailTab;
      drawTabs();
    });
    bindRoster($("corp-roster"), roster, (reload) => drawDetail(reload));
    if (logoDraft && logoDraft.corporationID !== id) logoDraft = null;
    bindLogo();
    $("corp-roster").addEventListener("click", (event) => {
      const button = event.target.closest("[data-sel]");
      if (button) void runSelection(button.dataset.sel);
    });
    $("corp-status").addEventListener("click", (event) => {
      const button = event.target.closest("[data-state]");
      if (!button) return;
      const state = button.dataset.state;
      if (roster.states.size === 1 && roster.states.has(state)) roster.states.clear();
      else { roster.states.clear(); roster.states.add(state); }
      roster.page = 0;
      void drawDetail(true);
    });
    $("corp-orders").addEventListener("click", (event) => {
      const button = event.target.closest("[data-corp-act]");
      if (!button) return;
      const action = button.dataset.corpAct;
      const c = detail.corporation;
      const arg = (name) => $("corp-orders").querySelector(`[data-corp-arg="${name}"]`);
      const hq = detail.headquarters && !detail.headquarters.error ? detail.headquarters.name || "the HQ" : "the HQ";
      if (action === "recall") return void runCorp("recall", {}, `Recall all ${num(c.botCount)} ${c.corporationName} pilots to ${hq}? They stop their work, fly there, dock and stay paused until you send them to work.`);
      if (action === "work") {
        const mode = arg("mode").value;
        return void runCorp("work", { mode, trips: Number(arg("trips").value) || 1 }, `Send all ${num(c.botCount)} ${c.corporationName} pilots to work (${arg("mode").selectedOptions[0].textContent})? This releases any recall hold.`);
      }
      if (action === "pause") return void runCorp("pause", {}, `Pause all ${num(c.botCount)} ${c.corporationName} pilots? Their operations wait where they are and the director gives them no new work until you resume them.`);
      if (action === "resume") return void runCorp("resume", {}, `Resume all ${num(c.botCount)} ${c.corporationName} pilots? This also lifts any recall hold, so the director can give them work again.`);
      if (action === "cancel") return void runCorp("cancel", {}, "Cancel this corporation's recall or work order? Pilots keep their current pause state.");
    });
    $("corp-hq").addEventListener("click", (event) => {
      const button = event.target.closest("[data-hq]");
      if (!button || button.tagName !== "BUTTON") return;
      if (button.dataset.hq === "clear") return void runCorp("hq-clear", {}, null);
      const picked = $("corp-hq").querySelector('[data-hq="pick"]');
      const typed = $("corp-hq").querySelector('[data-hq="id"]');
      const target = Number(typed.value) || Number(picked && picked.value) || 0;
      if (!target) return toast("Choose a structure or type a station or structure ID.", "bad");
      hqDraft = "";
      void runCorp("hq-set", { target }, null);
    });
    $("corp-orders").addEventListener("change", (event) => {
      if (event.target.dataset.corpArg === "mode") workMode = event.target.value;
      if (event.target.dataset.corpArg === "trips") workTrips = Math.max(1, Math.min(20, Number(event.target.value) || 1));
    });
    $("corp-hq").addEventListener("input", (event) => {
      if (event.target.dataset.hq === "id") hqDraft = event.target.value;
    });
    $("corp-hq").addEventListener("change", (event) => {
      if (event.target.dataset.deposit !== "mode" || !event.target.value) return;
      const division = Number($("corp-hq").querySelector('[data-deposit="division"]').value) || 1;
      void runCorp("deposit", { deposit: event.target.value, division }, null);
    });
    $("corp-prio").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-prio]");
      if (!button || button.tagName !== "BUTTON") return;
      const index = Number(button.dataset.index);
      const kind = button.dataset.prio;
      if (kind === "up" && index > 0) [priorityDraft[index - 1], priorityDraft[index]] = [priorityDraft[index], priorityDraft[index - 1]];
      if (kind === "down" && index < priorityDraft.length - 1) [priorityDraft[index + 1], priorityDraft[index]] = [priorityDraft[index], priorityDraft[index + 1]];
      if (kind === "remove") priorityDraft.splice(index, 1);
      if (["up", "down", "remove"].includes(kind)) priorityDirty = true;
      if (kind === "save") {
        try {
          const data = await postJSON("/api/corporation-priorities", { corporationID: detail.corporation.corporationID, priorityIDs: priorityDraft });
          if (data.success !== true) throw new Error(data.message || "Not saved.");
          toast("Priorities saved.", "good");
          priorityDirty = false;
          ctxRef.store.summaryAt = 0;
          return void drawDetail(false);
        } catch (error) { return toast(error.message, "bad"); }
      }
      const summary = await ctxRef.loadSummary(false);
      $("corp-prio").innerHTML = prioritiesHtml(summary.corporationPriorityOptions || []);
    });
    $("corp-prio").addEventListener("change", async (event) => {
      if (event.target.dataset.prio !== "add" || !event.target.value) return;
      priorityDraft.push(event.target.value);
      priorityDirty = true;
      const summary = await ctxRef.loadSummary(false);
      $("corp-prio").innerHTML = prioritiesHtml(summary.corporationPriorityOptions || []);
    });
  }
  await drawDetail(true);
}

export async function render(ctx) {
  ctxRef = ctx;
  if (ctx.param) return renderDetail(ctx.fresh);
  return renderList(ctx.fresh);
}
