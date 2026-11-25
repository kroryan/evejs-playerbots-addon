// Per-browser dashboard preferences: theme, refresh, pinned pilots and the
// small things the operator should not have to set twice. Stored in
// localStorage when the browser allows it; everything works without it.

const KEY = "playerbots.dashboard.v1";
const DEFAULTS = Object.freeze({
  theme: "dark",          // "dark" | "light" | "system"
  refreshSeconds: 15,     // 10 | 15 | 30 | 60
  refreshPaused: false,
  pinned: [],             // [{ characterID, characterName }]
  watchPanel: true,       // the right-hand watch panel on wide screens
  recent: [],             // recently opened pilots and corporations for the search
});
export const REFRESH_CHOICES = [10, 15, 30, 60];
const MAX_PINNED = 12;
const MAX_RECENT = 8;

let cache = null;
const listeners = new Set();

function read() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  if (!["dark", "light", "system"].includes(cache.theme)) cache.theme = DEFAULTS.theme;
  if (!REFRESH_CHOICES.includes(Number(cache.refreshSeconds))) cache.refreshSeconds = DEFAULTS.refreshSeconds;
  if (!Array.isArray(cache.pinned)) cache.pinned = [];
  if (!Array.isArray(cache.recent)) cache.recent = [];
  return cache;
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Private windows and locked-down browsers: keep the choice for this visit.
  }
  for (const listener of listeners) {
    try { listener(cache); } catch { /* a listener's problem is its own */ }
  }
}

export function prefs() {
  return read();
}

export function setPref(name, value) {
  read();
  cache[name] = value;
  write();
}

export function onPrefs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isPinned(characterID) {
  const id = Math.trunc(Number(characterID) || 0);
  return read().pinned.some((entry) => entry.characterID === id);
}

export function togglePin(characterID, characterName = "") {
  const id = Math.trunc(Number(characterID) || 0);
  if (!id) return false;
  const list = read().pinned.filter((entry) => entry.characterID !== id);
  const pinned = list.length === read().pinned.length;
  if (pinned) list.unshift({ characterID: id, characterName: String(characterName || "") });
  cache.pinned = list.slice(0, MAX_PINNED);
  write();
  return pinned;
}

export function remember(entry) {
  if (!entry || !entry.href) return;
  const list = read().recent.filter((item) => item.href !== entry.href);
  list.unshift({ href: entry.href, label: String(entry.label || ""), kind: entry.kind || "page" });
  cache.recent = list.slice(0, MAX_RECENT);
  write();
}

// The theme actually shown: "system" follows the operating system.
export function effectiveTheme(theme = read().theme) {
  if (theme !== "system") return theme;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = theme;
  return theme;
}
