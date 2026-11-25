// The dashboard's icon set: small stroke icons drawn for this add-on, on a
// 24 × 24 grid. icon(name) returns inline SVG that takes the text colour, so
// icons follow the theme and the state they sit in.

const P = {
  // Navigation
  activity: "M3 12h4l3-8 4 16 3-8h4",
  corporations: "M5 21V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V21M3 21h18M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10.5 21v-3h3v3",
  history: "M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4h4M12 7.5V12l3 2",
  world: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z",
  performance: "M4.2 17a8.5 8.5 0 1 1 15.6 0M12 15l4.5-5M12 15h.01",
  settings: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1M15 4.5v4M9 10v4M17 15.5v4",
  guide: "M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v15H7a2.5 2.5 0 0 0-2.5 2.5ZM4.5 20.5V5.5M19.5 18v3H7M8.5 7.5h7M8.5 11h5",
  fleet: "M12 3.5 15.5 10h-7ZM6 13.5 9.5 20h-7ZM18 13.5 21.5 20h-7ZM12 10v3.5M9 16.5h6",
  cargo: "M3.5 8 12 3.5 20.5 8v8.5L12 21l-8.5-4.5ZM3.5 8 12 12.5 20.5 8M12 12.5V21M7.8 5.7l8.4 4.6",
  // Actions
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM20 20l-4.6-4.6",
  refresh: "M19.5 11A7.5 7.5 0 0 0 6 6.2L4.5 7.7M4.5 3.8v3.9h3.9M4.5 13A7.5 7.5 0 0 0 18 17.8l1.5-1.5M19.5 20.2v-3.9h-3.9",
  pause: "M8 5v14M16 5v14",
  play: "M7.5 5.2v13.6a.7.7 0 0 0 1.1.6l10.2-6.8a.7.7 0 0 0 0-1.2L8.6 4.6a.7.7 0 0 0-1.1.6Z",
  pin: "M9 3.5h6M10 3.5l-.7 6L6.5 13h11l-2.8-3.5-.7-6M12 13v7.5",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15ZM10 20.5a2 2 0 0 0 4 0",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  moon: "M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z",
  close: "M6 6l12 12M18 6 6 18",
  "chevron-right": "m9.5 6 6 6-6 6",
  "chevron-left": "m14.5 6-6 6 6 6",
  "chevron-down": "m6 9.5 6 6 6-6",
  "arrow-up": "M12 19V5M6.5 10.5 12 5l5.5 5.5",
  "arrow-down": "M12 5v14M6.5 13.5 12 19l5.5-5.5",
  "arrow-left": "M19 12H5M10.5 6.5 5 12l5.5 5.5",
  external: "M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10",
  copy: "M9.5 8.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 19v-9a1.5 1.5 0 0 1 1.5-1.5ZM16 8.5V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8",
  download: "M12 4v11M7 10.5l5 5 5-5M5 20h14",
  filter: "M4 5h16l-6.2 7.3v5.4L10.2 20v-7.7Z",
  plus: "M12 5v14M5 12h14",
  more: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  menu: "M4 7h16M4 12h16M4 17h16",
  check: "m5 12.5 4.5 4.5L19 7.5",
  trash: "M4 7h16M9.5 3.5h5M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6",
  keyboard: "M4 6h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 18H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 6ZM6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9",
  // Things
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4.5 20.5a7.5 7.5 0 0 1 15 0",
  users: "M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM2.5 20a6.5 6.5 0 0 1 13 0M15.5 4.7a3.5 3.5 0 0 1 0 6.6M17.5 14.2a6.5 6.5 0 0 1 4 5.8",
  ship: "M12 2.5c3.4 2.6 5 6.6 4.6 11.4L14.5 17h-5l-2.1-3.1C7 9.1 8.6 5.1 12 2.5ZM12 8.2h.01M9.5 17 7 21M14.5 17 17 21M12 17v4.5",
  ore: "M7 3.5h10l4 5.5-9 12-9-12ZM3 9h18M9.5 3.5 12 9l2.5-5.5M12 9v12",
  planet: "M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM16.6 8.9c3.2-1.5 5.1-1.6 5.4-.8.6 1.5-3.9 5-10 7.6s-11.8 3.6-12.4 2c-.3-.8 1.1-2.2 3.8-3.7",
  target: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 1.5V6M12 18v4.5M1.5 12H6M18 12h4.5M12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z",
  upgrade: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 16.5v-9M8 11.5l4-4 4 4",
  home: "M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5",
  stop: "M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6Z",
  alert: "M12 3.5 21.5 20h-19ZM12 10v4.5M12 17.5h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v5.5M12 7.5h.01",
  image: "M5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 4ZM9 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM20.5 15.5 15.5 11 5 20",
  briefcase: "M4.5 7.5h15A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5ZM9 7.5V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5v2M3 13h18",
  flag: "M5.5 21V4M5.5 4.5h11l-2.5 4 2.5 4h-11",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
  shield: "M12 3 19.5 6v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6Z",
  "map-pin": "M12 21s-6.5-5.8-6.5-11.5a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21ZM12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  cpu: "M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM9.5 2.5V7M14.5 2.5V7M9.5 17v4.5M14.5 17v4.5M2.5 9.5H7M2.5 14.5H7M17 9.5h4.5M17 14.5h4.5",
  memory: "M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM7 17v2.5M12 17v2.5M17 17v2.5M7 10.5v3M10.5 10.5v3M14 10.5v3M17.5 10.5v3",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7.5V12l3 2",
  layers: "M12 3.5 21 8l-9 4.5L3 8ZM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5",
  sparkle: "M12 3.5c.6 3.9 2.1 6.4 6.5 8.5-4.4 2.1-5.9 4.6-6.5 8.5-.6-3.9-2.1-6.4-6.5-8.5 4.4-2.1 5.9-4.6 6.5-8.5Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  bolt: "M13 2.5 5 13.5h6l-1 8 8-11h-6Z",
  inbox: "M3.5 13.5 6 5.5h12l2.5 8M3.5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-5.5M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  hash: "M9.5 3.5 8 20.5M16 3.5l-1.5 17M4.5 9h16M3.5 15h16",
  panel: "M4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13A1.5 1.5 0 0 1 4.5 4ZM15 4v16",
  collapse: "M4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13A1.5 1.5 0 0 1 4.5 4ZM9 4v16M15.5 10l-2 2 2 2",
};

// Icons that read better filled.
const FILLED = new Set(["play"]);

export const ICON_NAMES = Object.freeze(Object.keys(P));

export function icon(name, { size = 20, label = "", cls = "" } = {}) {
  const d = P[name] || P.info;
  const fill = FILLED.has(name) ? "currentColor" : "none";
  const a11y = label ? `role="img" aria-label="${String(label).replace(/"/g, "&quot;")}"` : `aria-hidden="true" focusable="false"`;
  return `<svg class="icon${cls ? ` ${cls}` : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${a11y}><path d="${d}"/></svg>`;
}

// The Playerbots mark: a hexagonal hull with a pilot's face.
export function brandMark(size = 32) {
  return `<svg class="brand-svg" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2Z" fill="currentColor"/>
    <path d="M16 6.6 24.2 11.3v9.4L16 25.4l-8.2-4.7v-9.4Z" fill="var(--brand-inner, #000)"/>
    <circle cx="12.6" cy="15" r="1.9" fill="currentColor"/><circle cx="19.4" cy="15" r="1.9" fill="currentColor"/>
    <path d="M12.2 19.6h7.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
  </svg>`;
}
