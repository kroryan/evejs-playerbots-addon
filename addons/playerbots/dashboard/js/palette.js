// Search everything: pages, guide topics, corporations, pilots and
// dashboard commands, from one box. Ctrl+K, "/" or the Search button.

import { getJSON } from "./api.js";
import { $, esc, num, portrait, corpLogo } from "./ui.js";
import { icon } from "./icons.js";
import { prefs, remember } from "./prefs.js";
import { openPilot } from "./drawer.js";
import { TOPICS } from "./guide-content.js";

let state = null;

export function paletteOpen() {
  return Boolean(state);
}

export function closePalette() {
  if (!state) return;
  clearTimeout(state.timer);
  const back = state.returnFocus;
  state = null;
  $("palette-root").innerHTML = "";
  if (back && document.contains(back)) back.focus();
}

function words(text) {
  return String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(hay, query) {
  const text = String(hay || "").toLowerCase();
  return words(query).every((word) => text.includes(word));
}

function staticItems(ctx, query) {
  const groups = [];
  const p = prefs();
  const pages = [
    ...ctx.nav.map((item) => ({ kind: "page", icon: item.icon, title: item.label, sub: `Go to ${item.label}`, href: `#${item.view}`, hint: `G ${item.key.toUpperCase()}` })),
    { kind: "page", icon: "map-pin", title: "World · Systems", sub: "Where pilots are", href: "#world" },
    { kind: "page", icon: "flag", title: "World · Territory", sub: "Fleets, wars, structures and sovereignty", href: "#world/territory" },
    { kind: "page", icon: "target", title: "World · Killboard", sub: "Recent kills and losses", href: "#world/killboard" },
  ];
  const commands = [
    { kind: "command", icon: "refresh", title: "Refresh now", sub: "Reload this page's data", hint: "R", run: () => ctx.refreshNow() },
    { kind: "command", icon: p.refreshPaused ? "play" : "pause", title: p.refreshPaused ? "Resume live updates" : "Pause live updates", sub: "Pages refresh on their own while live", hint: "L", run: () => ctx.toggleLive() },
    { kind: "command", icon: "moon", title: "Black mode", sub: "The default look", run: () => ctx.setTheme("dark") },
    { kind: "command", icon: "sun", title: "White mode", sub: "A light background", run: () => ctx.setTheme("light") },
    { kind: "command", icon: "eye", title: "Match my system theme", sub: "Follow the operating system's light or dark setting", run: () => ctx.setTheme("system") },
    { kind: "command", icon: "panel", title: "Show or hide the watch panel", sub: "Server numbers, pinned pilots and the latest operations, on wide screens", hint: "W", run: () => ctx.toggleWatch() },
    { kind: "command", icon: "keyboard", title: "Keyboard shortcuts", sub: "Every key the dashboard knows", hint: "?", run: () => ctx.showShortcuts() },
    { kind: "command", icon: "users", title: "Filter pilots by state", sub: "Open Activity and pick a state above the list", href: "#activity" },
    { kind: "command", icon: "image", title: "Corporation logos", sub: "Give a corporation a picture logo (open a corporation)", href: "#corporations" },
  ];
  if (!query) {
    if (p.recent.length) {
      groups.push({ title: "Recent", items: p.recent.map((entry) => ({ kind: entry.kind, icon: entry.kind === "pilot" ? "user" : entry.kind === "corporation" ? "corporations" : "chevron-right", title: entry.label, sub: entry.kind === "pilot" ? "Pilot" : entry.kind === "corporation" ? "Corporation" : "Page", href: entry.href, pilotID: entry.kind === "pilot" ? Number(entry.href.split("/").pop()) : 0 })) });
    }
    groups.push({ title: "Pages", items: pages.slice(0, 7) });
    groups.push({ title: "Commands", items: commands.slice(0, 2).concat(commands.slice(5, 6)) });
    return groups;
  }
  const pageHits = pages.filter((item) => matches(`${item.title} ${item.sub}`, query));
  const commandHits = commands.filter((item) => matches(`${item.title} ${item.sub}`, query));
  const corps = (ctx.store.summary?.corporations || []).filter((c) => c.botCount > 0 && matches(`${c.corporationName} ${c.ticker} ${c.allianceName || ""} ${c.corporationID}`, query)).slice(0, 6)
    .map((c) => ({ kind: "corporation", logo: corpLogo(c.corporationID, 34) || "", icon: "corporations", title: `${c.corporationName} [${c.ticker}]`, sub: `${num(c.botCount)} pilots${c.allianceName ? ` · ${c.allianceName}` : ""}`, href: `#corporations/${c.corporationID}` }));
  const topics = TOPICS.filter((topic) => matches(`${topic.title} ${topic.summary} ${topic.keywords || ""}`, query)).slice(0, 5)
    .map((topic) => ({ kind: "topic", icon: "guide", title: topic.title, sub: topic.summary, href: `#guide/${topic.id}` }));
  if (pageHits.length) groups.push({ title: "Pages", items: pageHits });
  if (corps.length) groups.push({ title: "Corporations", items: corps });
  groups.push({ title: "Pilots", items: state.pilots || [], loading: state.pilotsFor !== query });
  if (topics.length) groups.push({ title: "Guide", items: topics });
  if (commandHits.length) groups.push({ title: "Commands", items: commandHits });
  return groups;
}

function draw() {
  if (!state) return;
  const groups = staticItems(state.ctx, state.query).filter((group) => group.items.length || group.loading);
  state.flat = groups.flatMap((group) => group.items);
  if (state.active >= state.flat.length) state.active = Math.max(0, state.flat.length - 1);
  let index = -1;
  const html = groups.map((group) => `<div class="palette-group">${esc(group.title)}</div>${group.items.map((item) => {
    index += 1;
    const visual = item.pilotID ? portrait(item.pilotID, 64) : item.logo || icon(item.icon || "chevron-right", { size: 18 });
    return `<button class="palette-item${index === state.active ? " active" : ""}" type="button" data-index="${index}" role="option" aria-selected="${index === state.active}">
      <span class="pi-icon">${visual}</span><span class="pi-text"><strong>${esc(item.title)}</strong>${item.sub ? `<small>${esc(item.sub)}</small>` : ""}</span>${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ""}</button>`;
  }).join("")}${group.loading && !group.items.length ? `<div class="palette-empty">Searching pilots…</div>` : ""}`).join("");
  const results = $("palette-results");
  results.innerHTML = html || `<div class="palette-empty">Nothing matches “${esc(state.query)}”.</div>`;
  results.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
}

async function searchPilots(query) {
  if (!state || !query) return;
  try {
    const data = await getJSON(`/api/bots?${new URLSearchParams({ search: query, limit: "8", offset: "0" })}`);
    if (!state || state.query !== query) return;
    state.pilots = (data.rows || []).map((row) => ({
      kind: "pilot", pilotID: row.characterID, title: row.characterName,
      sub: `${row.stateLabel || row.state}${row.corporationTicker ? ` · [${row.corporationTicker}]` : ""} · ${row.where || ""}`,
      href: `#pilot/${row.characterID}`,
    }));
  } catch {
    if (!state || state.query !== query) return;
    state.pilots = [];
  }
  state.pilotsFor = query;
  draw();
}

function choose(index) {
  const item = state && state.flat[index];
  if (!item) return;
  closePalette();
  if (item.run) return item.run();
  if (item.kind === "pilot") {
    remember({ href: `#pilot/${item.pilotID}`, label: item.title, kind: "pilot" });
    return openPilot(item.pilotID);
  }
  if (item.kind === "corporation") remember({ href: item.href, label: item.title, kind: "corporation" });
  if (item.href) location.hash = item.href;
}

export function openPalette(ctx) {
  if (state) return;
  state = { ctx, query: "", active: 0, flat: [], pilots: [], pilotsFor: "", timer: null, returnFocus: document.activeElement };
  $("palette-root").innerHTML = `<div class="palette-backdrop" data-palette-close></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Search">
      <div class="palette-input">${icon("search", { size: 20 })}<input id="palette-input" type="text" placeholder="Search pilots, corporations, pages and commands" autocomplete="off" spellcheck="false" aria-controls="palette-results"><kbd>Esc</kbd></div>
      <div class="palette-results" id="palette-results" role="listbox"></div>
      <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
    </div>`;
  const input = $("palette-input");
  input.focus();
  draw();
  input.addEventListener("input", () => {
    state.query = input.value.trim();
    state.active = 0;
    state.pilots = [];
    clearTimeout(state.timer);
    if (state.query) state.timer = setTimeout(() => void searchPilots(state.query), 220);
    draw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); state.active = Math.min(state.flat.length - 1, state.active + 1); draw(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); state.active = Math.max(0, state.active - 1); draw(); }
    else if (event.key === "Enter") { event.preventDefault(); choose(state.active); }
    else if (event.key === "Escape") { event.preventDefault(); closePalette(); }
  });
  $("palette-root").onclick = (event) => {
    if (event.target.closest("[data-palette-close]")) return closePalette();
    const item = event.target.closest("[data-index]");
    if (item) choose(Number(item.dataset.index));
  };
}
