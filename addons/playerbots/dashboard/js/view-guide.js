// Guide: the add-on's documentation, built into the dashboard.
// #guide is the contents page, #guide/<topic> one topic. Static content only,
// so the page never refreshes on the timer.

import { $, esc, toast, pageHead, icon } from "./ui.js";
import { COMMANDS, GROUPS, TOPICS } from "./guide-content.js";

export const autoRefresh = false;

const byId = new Map(TOPICS.map((topic) => [topic.id, topic]));
let query = "";
let currentTopic = "";
let wired = false;

const QUICK = [
  ["first-hour", "Set up a new server", "Seeding, autonomous work and what to expect.", "sparkle"],
  ["activity", "See why bots aren't working", "States, reasons and the director.", "activity"],
  ["corporations", "Recall or move a corporation", "Whole-corporation and per-pilot orders.", "home"],
  ["recruitment", "Put bots in my corporation", "Invite them all, or recruit automatically.", "users"],
  ["fleets", "Fly with bots", "Fleets, /follow, /escort and /attack.", "ship"],
  ["troubleshooting", "Fix a problem", "Common messages and what to do.", "alert"],
];

function normal(text) {
  return String(text || "").toLowerCase().replace(/<[^>]+>/g, " ");
}

function matchesTopic(topic, words) {
  const hay = normal(`${topic.title} ${topic.summary} ${topic.keywords || ""}`);
  return words.every((word) => hay.includes(word));
}

function matchesCommand(command, words) {
  const hay = normal(`${command.command} ${command.what} ${command.group}`);
  return words.every((word) => hay.includes(word));
}

function copyButton(text) {
  return `<button type="button" class="g-copy" data-copy="${esc(text)}" title="Copy to clipboard">Copy</button>`;
}

function commandRow(command) {
  return `<tr><td><code class="g-code">${esc(command.command)}</code>${command.sample ? `<div class="g-sample">e.g. <code>${esc(command.sample)}</code> ${copyButton(command.sample)}</div>` : ""}</td><td>${esc(command.what)}</td></tr>`;
}

function commandTable(commands) {
  const groups = [...new Set(commands.map((command) => command.group))];
  return groups.map((group) => `<h3 class="g-group-title">${esc(group)}</h3>
    <div class="table-wrap"><table class="g-table g-commands"><thead><tr><th>Command</th><th>What it does</th></tr></thead><tbody>
    ${commands.filter((command) => command.group === group).map(commandRow).join("")}
    </tbody></table></div>`).join("");
}

function sidebar(active) {
  return `<aside class="g-side">
    <label class="g-search"><span class="sr-only">Search the guide</span>
      <input id="guide-search" type="search" placeholder="Search the guide…" value="${esc(query)}" autocomplete="off">
    </label>
    <nav class="g-toc" aria-label="Guide topics">
      <a class="g-toc-link${active ? "" : " active"}" href="#guide">Contents</a>
      ${GROUPS.map((group) => `<div class="g-toc-group">${esc(group.title)}</div>
        ${TOPICS.filter((topic) => topic.group === group.id).map((topic) => `<a class="g-toc-link${topic.id === active ? " active" : ""}" href="#guide/${topic.id}">${esc(topic.title)}</a>`).join("")}`).join("")}
    </nav>
  </aside>`;
}

function contents() {
  return `${pageHead("guide", "Guide", `How to run Playerbots, in plain words. Every page has a guide button ${icon("guide", { size: 15 })} in the top bar that opens its topic here, and <kbd>Ctrl</kbd> <kbd>K</kbd> searches the guide too.`)}
    <h2 class="g-h2">Common tasks</h2>
    <div class="g-cards">
      ${QUICK.map(([id, title, text, iconName]) => `<a class="g-card" href="#guide/${id}">${icon(iconName, { size: 18 })}<strong>${esc(title)}</strong><span>${esc(text)}</span></a>`).join("")}
    </div>
    ${GROUPS.map((group) => `<h2 class="g-h2">${esc(group.title)}</h2>
      <div class="g-index">
        ${TOPICS.filter((topic) => topic.group === group.id).map((topic) => `<a class="g-index-row" href="#guide/${topic.id}"><strong>${esc(topic.title)}</strong><span>${esc(topic.summary)}</span></a>`).join("")}
      </div>`).join("")}`;
}

function article(topic) {
  const index = TOPICS.indexOf(topic);
  const previous = TOPICS[index - 1];
  const next = TOPICS[index + 1];
  const group = GROUPS.find((entry) => entry.id === topic.group);
  return `<article class="g-article">
    <div class="g-eyebrow">${esc(group ? group.title : "Guide")}</div>
    <h1>${esc(topic.title)}</h1>
    <p class="g-lede">${esc(topic.summary)}</p>
    <div class="g-body">${topic.body()}${topic.commands ? commandTable(COMMANDS) : ""}</div>
    <nav class="g-pager" aria-label="More topics">
      ${previous ? `<a href="#guide/${previous.id}"><small>Previous</small>← ${esc(previous.title)}</a>` : "<span></span>"}
      ${next ? `<a class="next" href="#guide/${next.id}"><small>Next</small>${esc(next.title)} →</a>` : "<span></span>"}
    </nav>
  </article>`;
}

function results() {
  const words = normal(query).split(/\s+/).filter(Boolean);
  const topics = TOPICS.filter((topic) => matchesTopic(topic, words));
  const commands = COMMANDS.filter((command) => matchesCommand(command, words));
  if (!topics.length && !commands.length) {
    return `<div class="g-article"><h1>No results</h1><p class="g-lede">Nothing matches “${esc(query)}”. Try a shorter word, such as <em>mine</em>, <em>recall</em> or <em>fleet</em>.</p></div>`;
  }
  return `<div class="g-article">
    <h1>Results for “${esc(query)}”</h1>
    ${topics.length ? `<h2 class="g-h2">Topics</h2><div class="g-index">${topics.map((topic) => `<a class="g-index-row" href="#guide/${topic.id}"><strong>${esc(topic.title)}</strong><span>${esc(topic.summary)}</span></a>`).join("")}</div>` : ""}
    ${commands.length ? `<h2 class="g-h2">Commands</h2>${commandTable(commands)}` : ""}
  </div>`;
}

function mainContent() {
  if (query.trim()) return results();
  if (!currentTopic) return contents();
  const topic = byId.get(currentTopic);
  return topic
    ? article(topic)
    : `<div class="notice error">There is no guide topic called “${esc(currentTopic)}”. <a href="#guide">Back to contents</a></div>`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } finally { area.remove(); }
  }
}

function wire() {
  if (wired) return;
  wired = true;
  $("view").addEventListener("click", (event) => {
    const button = event.target.closest(".g-copy");
    if (!button || !$("view").contains(button)) return;
    const text = button.dataset.copy || "";
    void copy(text).then(() => {
      toast(`Copied ${text}`);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1500);
    }, () => toast("Could not copy; select the text instead.", "bad"));
  });
  $("view").addEventListener("input", (event) => {
    if (event.target.id !== "guide-search") return;
    query = event.target.value;
    const main = $("guide-main");
    if (main) main.innerHTML = mainContent();
  });
  // Following a link from the results clears the search.
  $("view").addEventListener("click", (event) => {
    const link = event.target.closest("#guide-main a[href^='#guide']");
    if (!link || !query) return;
    query = "";
    const search = $("guide-search");
    if (search) search.value = "";
    // A link to the topic already open does not change the address.
    if (link.getAttribute("href") === location.hash) {
      event.preventDefault();
      $("guide-main").innerHTML = mainContent();
      window.scrollTo(0, 0);
    }
  });
}

export async function render({ param, setCrumbs, loadSummary }) {
  wire();
  // Keeps the connection status in the corner current; the guide itself needs no data.
  if (loadSummary) void loadSummary().catch(() => {});
  const topicId = String(param || "").split("/")[0];
  if (topicId !== currentTopic) query = "";
  currentTopic = topicId;
  const topic = byId.get(topicId);
  setCrumbs(topic ? [{ label: "Guide", href: "#guide" }, { label: topic.title }] : [{ label: "Guide" }]);
  $("view").innerHTML = `<div class="guide">${sidebar(topicId)}<div id="guide-main" class="g-main">${mainContent()}</div></div>`;
  window.scrollTo(0, 0);
}
