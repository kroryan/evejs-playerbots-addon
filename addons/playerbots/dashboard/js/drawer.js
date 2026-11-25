// Pilot drawer: everything about one pilot plus the orders the operator can
// give it.

import { getJSON, botCommand, corpCommand } from "./api.js";
import { $, esc, num, isk, portrait, stateTag, when, toast, corpLogo, emptyState } from "./ui.js";
import { icon } from "./icons.js";
import { isPinned, togglePin, remember } from "./prefs.js";

let current = { characterID: 0, onChange: null, pilot: null };
let lastFocus = null;

export function closeDrawer() {
  if (!current.characterID && !$("drawer-root").innerHTML) return;
  $("drawer-root").innerHTML = "";
  current = { characterID: 0, onChange: null, pilot: null };
  document.removeEventListener("keydown", onKey);
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

function onKey(event) {
  if (event.key === "Escape" && !$("dialog").open && !document.querySelector(".palette")) closeDrawer();
}

const HEAD = (title) => `<div class="drawer-head"><strong>${esc(title)}</strong><button class="close" type="button" data-close aria-label="Close" title="Close (Esc)">${icon("close", { size: 18 })}</button></div>`;

export async function openPilot(characterID, onChange = null) {
  if (!current.characterID) lastFocus = document.activeElement;
  current = { characterID, onChange, pilot: null };
  document.addEventListener("keydown", onKey);
  $("drawer-root").innerHTML = `<div class="drawer-backdrop" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Pilot details" tabindex="-1">${HEAD("Pilot")}<div class="drawer-profile"><div class="skeleton" style="width:76px;height:76px;border-radius:12px"></div><div style="display:grid;gap:10px;align-content:center"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%"></div></div></div></aside>`;
  $("drawer-root").querySelector(".drawer").focus();
  bind();
  await reload();
}

async function reload() {
  const id = current.characterID;
  if (!id) return;
  let pilot;
  try {
    pilot = await getJSON(`/api/bot?characterID=${id}`);
  } catch (error) {
    if (current.characterID !== id) return;
    $("drawer-root").querySelector(".drawer").innerHTML = `${HEAD("Pilot")}<section>${emptyState("alert", "Could not load this pilot", error.message)}</section>`;
    return;
  }
  if (current.characterID !== id) return;
  current.pilot = pilot;
  remember({ href: `#pilot/${pilot.characterID}`, label: pilot.characterName, kind: "pilot" });
  const drawer = $("drawer-root").querySelector(".drawer");
  const scroll = drawer.scrollTop;
  drawer.innerHTML = drawerHtml(pilot);
  drawer.scrollTop = scroll;
}

function orderCard(title, iconName, act, opts = "", kind = "") {
  return `<div class="order-card"><div class="order-title">${icon(iconName, { size: 18 })}${esc(title)}</div>${opts ? `<div class="order-opts">${opts}</div>` : ""}<button class="btn small${kind ? ` ${kind}` : ""}" type="button" data-act="${act}">${icon("play", { size: 14 })}<span>Start</span></button></div>`;
}

function drawerHtml(p) {
  const op = p.currentOperation;
  const ticker = p.corporationTicker ? `[${esc(p.corporationTicker)}] ` : "";
  const working = ["working", "travelling", "holding"].includes(p.state);
  const pinned = isPinned(p.characterID);
  const quick = [
    p.paused
      ? `<button class="btn small primary" type="button" data-act="resume">${icon("play", { size: 16 })}<span>Resume</span></button>`
      : `<button class="btn small" type="button" data-act="pause">${icon("pause", { size: 16 })}<span>Pause</span></button>`,
    working ? `<button class="btn small" type="button" data-act="stop">${icon("stop", { size: 16 })}<span>Stop operation</span></button>` : "",
    p.operation && ["stopped", "holding", "failed"].includes(p.operation.status) ? `<button class="btn small" type="button" data-act="resume-op">${icon("refresh", { size: 16 })}<span>Resume operation</span></button>` : "",
    p.corporationID ? `<button class="btn small" type="button" data-act="recall">${icon("home", { size: 16 })}<span>Recall to corp HQ</span></button>` : "",
  ].filter(Boolean).join("");
  return `
  ${HEAD("Pilot")}
  <div class="drawer-profile">
    ${portrait(p.characterID, 256).replace("<img ", '<img class="avatar" ')}
    <div>
      <h2>${esc(p.characterName)}</h2>
      <div class="handle">${corpLogo(p.corporationID, 16, "corp-logo inline")}${ticker}${p.corporationID ? `<a href="#corporations/${esc(p.corporationID)}">${esc(p.corporationName)}</a>` : esc(p.corporationName || "No corporation")}</div>
      <div class="profile-actions">
        <button class="btn small${pinned ? " contrast" : ""}" type="button" data-pin title="${pinned ? "Remove from the watch panel" : "Keep this pilot in the watch panel"}">${icon("pin", { size: 14 })}<span>${pinned ? "Pinned" : "Pin"}</span></button>
        <button class="btn small" type="button" data-copy="${esc(p.characterID)}" title="Copy the character ID">${icon("copy", { size: 14 })}<span>Copy ID</span></button>
      </div>
    </div>
    <div class="now"><strong>${esc(p.doing)}</strong>${p.reason ? `<div class="muted" style="margin-top:2px">${esc(p.reason)}</div>` : ""}${p.retryAt ? `<div class="muted" style="margin-top:2px">The director retries ${when(p.retryAt)}.</div>` : ""}</div>
    <div class="profile-line">
      ${stateTag(p.state, p.stateLabel)}
      <span>${icon("briefcase")}${esc(p.specialty)}</span>
      <span>${icon("map-pin")}${esc(p.where)}${p.security !== null && p.security !== undefined ? ` (${Number(p.security).toFixed(1)})` : ""}</span>
      <span>${icon("ship")}${esc(p.shipName || (p.shipTypeID ? `Type ${p.shipTypeID}` : "No ship"))}</span>
      ${p.createdAt ? `<span>${icon("clock")}Joined ${when(p.createdAt)}</span>` : ""}
    </div>
    <div class="actions">${quick}</div>
  </div>
  <section><h3>${icon("info", { size: 18 })}Pilot</h3><dl class="kv">
    <dt>Online</dt><dd>${p.connected ? (p.inSpace ? "Yes, in space" : "Yes, docked") : "No"}</dd>
    <dt>Paused</dt><dd>${p.paused ? "Yes" : "No"}</dd>
    <dt>Character ID</dt><dd class="mono">${esc(p.characterID)}</dd>
  </dl></section>
  ${op ? `<section><h3>${icon("activity", { size: 18 })}Current operation · ${esc(op.kindLabel)}</h3>
    <dl class="kv"><dt>Status</dt><dd>${esc(op.status)}${op.stage ? ` · ${esc(op.stage)}` : ""}</dd><dt>Started</dt><dd>${when(op.startedAt) || "—"}</dd><dt>Updated</dt><dd>${when(op.updatedAt) || "—"}</dd><dt>ID</dt><dd class="mono">${esc(op.operationID)}</dd></dl>
    ${op.history.length ? `<ol class="timeline" style="margin-top:14px">${op.history.slice().reverse().map((h) => `<li><time>${when(h.at)}</time> <strong>${esc(h.stageLabel || h.stage)}</strong><div>${esc(h.message)}</div></li>`).join("")}</ol>` : ""}
  </section>` : ""}
  ${p.tasks && p.tasks.length ? `<section><h3>${icon("list", { size: 18 })}Queued tasks</h3>${p.tasks.map((t) => `<div style="margin-bottom:4px">${esc(t.kind)} · ${esc(t.status)}${t.stage ? ` · ${esc(t.stage)}` : ""} <span class="mono muted">${esc(t.taskID)}</span></div>`).join("")}</section>` : ""}
  ${p.director && (p.director.lastMessage || p.director.lastAssignment) ? `<section><h3>${icon("sparkle", { size: 18 })}Director's last note</h3><p>${esc(p.director.lastAssignment ? `${p.director.lastAssignment}: ` : "")}${esc(p.director.lastMessage || "—")}</p>${p.director.cooldownUntil ? `<p class="muted" style="margin-top:4px">Cooling down until ${esc(new Date(p.director.cooldownUntil).toLocaleTimeString())}.</p>` : ""}</section>` : ""}
  <section><h3>${icon("history", { size: 18 })}Recent operations</h3>${(p.recentOperations || []).map((o) => `<div style="margin-bottom:10px"><strong>${esc(o.kindLabel || o.kind)}</strong> <span class="muted">· ${esc(o.status)} · ${when(o.updatedAt)}</span>${Number(o.spent) || Number(o.proceeds) ? ` <span class="muted">·</span> ${Number(o.spent) ? `<span class="isk-out">−${esc(isk(o.spent))}</span>` : ""}${Number(o.spent) && Number(o.proceeds) ? " / " : ""}${Number(o.proceeds) ? `<span class="isk-in">+${esc(isk(o.proceeds))}</span>` : ""}` : ""}<div class="muted" style="font-size:13.5px">${esc(o.lastAction || "")}</div></div>`).join("") || `<p class="muted">None recorded.</p>`}</section>
  <section><h3>${icon("bolt", { size: 18 })}Give an order</h3>
    <div class="order-grid">
      ${orderCard("Mine", "ore", "mine", `<label class="muted">Trips <input class="field" style="width:64px" type="number" min="1" max="20" value="1" data-arg="trips"></label><label class="muted">Station <input class="field" style="width:120px" type="number" min="1" placeholder="nearest" data-arg="station"></label>`)}
      ${orderCard("Set up a PI colony", "planet", "colony")}
      ${orderCard("Combat patrol", "target", "combat", `<select class="field" data-arg="mode" aria-label="Patrol type"><option value="">By specialty</option><option value="security">Security</option><option value="war">War</option><option value="piracy">Piracy</option><option value="nullsec-conflict">Null-sec conflict</option></select>`)}
      ${orderCard("Upgrade ship", "upgrade", "upgrade", `<select class="field" data-arg="role" aria-label="Ship role"><option value="">By specialty</option><option value="mining">Mining</option><option value="logistics">Logistics</option><option value="security">Security</option><option value="piracy">Piracy</option><option value="sovereignty">Sovereignty</option></select><label class="muted check"><input type="checkbox" data-arg="force"> Force</label>`)}
    </div>
    <p class="muted small" style="margin-top:12px">${p.paused ? "This pilot is paused. Starting a job resumes it, and the director takes over again once the job ends." : "When a job you start here ends, the director takes over again."}</p>
  </section>`;
}

function bind() {
  const root = $("drawer-root");
  root.onclick = async (event) => {
    if (event.target.closest("[data-close]")) return closeDrawer();
    if (event.target.closest("a[href^='#corporations/']")) return closeDrawer();
    const pin = event.target.closest("[data-pin]");
    if (pin && current.pilot) {
      const nowPinned = togglePin(current.pilot.characterID, current.pilot.characterName);
      toast(nowPinned ? `${current.pilot.characterName} is pinned to the watch panel.` : `${current.pilot.characterName} is unpinned.`);
      $("drawer-root").querySelector(".drawer").innerHTML = drawerHtml(current.pilot);
      return;
    }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        toast(`Copied character ID ${copy.dataset.copy}.`);
      } catch {
        toast(`Character ID ${copy.dataset.copy}`);
      }
      return;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const drawer = root.querySelector(".drawer");
    const card = button.closest(".order-card") || drawer;
    const arg = (name) => card.querySelector(`[data-arg="${name}"]`);
    const action = button.dataset.act;
    const id = current.characterID;
    button.disabled = true;
    try {
      let result;
      if (action === "recall") {
        const pilot = current.pilot || await getJSON(`/api/bot?characterID=${id}`);
        result = await corpCommand(pilot.corporationID, "recall", { characterIDs: [id] }).then((data) => ({ ok: 1, message: data.message })).catch((error) => ({ ok: 0, message: error.message }));
      } else {
        const args = {};
        if (action === "mine") { args.trips = Number(arg("trips").value) || 1; if (Number(arg("station").value)) args.station = Number(arg("station").value); }
        if (action === "combat" && arg("mode").value) args.mode = arg("mode").value;
        if (action === "upgrade") { if (arg("role").value) args.role = arg("role").value; args.force = arg("force").checked; }
        result = await botCommand([id], action, args);
      }
      toast(result.message, result.ok ? "good" : "bad");
      await reload();
      if (current.onChange) current.onChange();
    } catch (error) {
      toast(error.message, "bad");
    } finally {
      button.disabled = false;
    }
  };
}

export function pilotCountLabel(count) {
  return `${num(count)} pilot${Number(count) === 1 ? "" : "s"}`;
}
