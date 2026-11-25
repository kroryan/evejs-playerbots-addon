// Performance: event loop, CPU, memory, scheduler and space-tick telemetry.
// Telemetry is requested only while this page is open.

import { getJSON } from "./api.js";
import { $, esc, num, ms, stat, emptyRow, pageHead, icon, notice, sparkline } from "./ui.js";

// Recent readings while this page is open, for the trend lines.
const history = { p95: [], cpu: [], rss: [] };
function track(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  history[key].push(n);
  if (history[key].length > 30) history[key].shift();
}

const mib = (bytes) => `${num(Math.round(Number(bytes || 0) / 1_048_576))} MiB`;
const pct = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(0)}%`;

function html(data) {
  const loop = data.eventLoop || {};
  const current = loop.current || {};
  const cpu = data.cpu || {};
  const memory = data.memory || {};
  const gc = (data.gc && data.gc.recent) || {};
  const scene = data.scene || {};
  const guard = data.loadGuard || {};
  const stateName = String(loop.state || "unknown");
  const label = { healthy: "Healthy", constrained: "Constrained", degraded: "Degraded", overloaded: "Overloaded" }[stateName] || "Unknown";
  const pill = { healthy: "good", constrained: "warn", degraded: "warn", overloaded: "bad" }[stateName] || "";
  const scheduler = data.scheduler || {};
  const queue = scheduler.queue || {};
  const lateness = scheduler.lateness || {};
  const scanned = Boolean(queue.byType);
  const types = [...new Set([...Object.keys(queue.byType || {}), ...Object.keys(lateness)])].sort();
  const work = Object.entries(data.work || {}).sort((a, b) => Number(b[1].p95Ms || 0) - Number(a[1].p95Ms || 0)).slice(0, 25);
  const tick = data.spaceTick || {};
  const dispatch = scheduler.dispatch;
  track("p95", current.p95Ms);
  track("cpu", cpu.process && cpu.process.totalPercent);
  track("rss", memory.rssBytes);
  return `${pageHead("performance", "Performance", "Measurements of this server, not capacity guarantees.", `<span class="pill ${pill}">${icon(pill === "good" ? "check" : "alert", { size: 16 })}Event loop: ${esc(label)}</span>`)}
  <div class="stats">
    ${stat("Event-loop delay p95", ms(current.p95Ms), `longest ${ms(current.maxMs)} in ${num(loop.windowSeconds)} s`, pill === "good" ? "green" : pill === "bad" ? "red" : "amber", "clock", sparkline(history.p95))}
    ${stat("EveJS CPU", pct(cpu.process && cpu.process.totalPercent), `main thread ${pct(cpu.mainThread && cpu.mainThread.totalPercent)} · host ${pct(cpu.host && cpu.host.busyPercent)} of ${num(cpu.host && cpu.host.logicalCpus)} CPUs`, "cyan", "cpu", sparkline(history.cpu))}
    ${stat("Memory", mib(memory.rssBytes), `heap ${mib(memory.heapUsedBytes)} of ${mib(memory.heapSizeLimitBytes)} · GC p95 ${ms(gc.p95DurationMs)}`, "violet", "memory", sparkline(history.rss))}
    ${stat("Bot ships in space", num(scene.botsInSpace), `${num(scene.systemsWithBotsInSpace)} systems · ${num(scene.botsInUnobservedSystems)} where no human is in space`, "amber", "ship")}
    ${stat("Bot steps in parallel", `${num(guard.effectiveStepConcurrency)} / ${num(guard.configuredStepConcurrency)}`, "lowered automatically under load", "cyan", "layers")}
  </div>
  <div class="panel"><div class="panel-head"><div><h2>${icon("clock")}Scheduled playerbot work</h2><p>${dispatch ? `${num(dispatch.active)} of ${num(dispatch.maxConcurrent)} dispatch slots in use, ${num(dispatch.queued)} waiting. ` : ""}${scanned ? "" : "Queue counts need the optional queue scan; start delay is always measured."}</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Job type</th><th class="num">Scheduled</th><th class="num">Running</th><th class="num">Due now</th><th class="num">Oldest overdue</th><th class="num">Start delay p95</th><th class="num">Start delay max</th></tr></thead><tbody>
    ${types.map((type) => { const row = (queue.byType || {})[type] || {}; const late = lateness[type] || {}; return `<tr><td class="mono">${esc(type)}</td><td class="num">${scanned ? num(row.scheduled) : "—"}</td><td class="num">${scanned ? num(row.running) : "—"}</td><td class="num">${scanned ? num(row.due) : "—"}</td><td class="num">${row.due ? esc(ms(row.oldestOverdueMs)) : "—"}</td><td class="num">${late.samples ? esc(ms(late.p95Ms)) : "—"}</td><td class="num">${late.samples ? esc(ms(late.maximumMs)) : "—"}</td></tr>`; }).join("") || emptyRow(7, queue.error ? `Scheduler queue unavailable: ${queue.error}` : "No scheduled playerbot work has started yet.")}
    </tbody></table></div></div>
  <div class="panel"><div class="panel-head"><div><h2>${icon("cpu")}Time by subsystem</h2><p>Recent duration of each measured pass, slowest first</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Subsystem</th><th class="num">Runs</th><th class="num">Average</th><th class="num">p95</th><th class="num">Longest</th><th class="num">Yields</th><th>Last run</th></tr></thead><tbody>
    ${work.map(([name, row]) => `<tr><td class="mono">${esc(name)}</td><td class="num">${num(row.samples)}</td><td class="num">${esc(ms(row.averageMs))}</td><td class="num">${esc(ms(row.p95Ms))}</td><td class="num">${esc(ms(row.maximumMs))}</td><td class="num">${num(row.yields)}</td><td>${esc(row.lastAt ? new Date(row.lastAt).toLocaleTimeString() : "—")}</td></tr>`).join("") || emptyRow(7, "Nothing measured yet.")}
    </tbody></table></div></div>
  <div class="panel"><div class="panel-head"><div><h2>${icon("alert")}Long space ticks</h2><p>${tick.enabled === false ? "The stall watch is off." : `${num(tick.stalls)} of ${num(tick.ticks)} ticks held the server for ${ms(tick.thresholdMs)} or longer (longest ${ms(tick.longestMs)}).`}</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th class="num">Held for</th><th class="num">Started late</th><th class="num">Systems</th><th>Slowest systems</th></tr></thead><tbody>
    ${(tick.recent || []).map((row) => `<tr><td>${esc(String(row.at || "").slice(11, 19))}</td><td class="num">${esc(ms(row.durationMs))}</td><td class="num">${esc(ms(row.startedLateMs))}</td><td class="num">${num(row.scenesTicked)}</td><td class="mono">${esc((row.slowestScenes || []).map((s) => `${s.solarSystemID}: ${ms(s.workMs)} (${num(s.botSessions)} bots)`).join(" · "))}</td></tr>`).join("") || emptyRow(5, "No long ticks recorded.")}
    </tbody></table></div></div>`;
}

export async function render() {
  try {
    const data = await getJSON("/api/telemetry");
    $("view").innerHTML = html(data);
  } catch (error) {
    $("view").innerHTML = `${pageHead("performance", "Performance")}${notice(`Telemetry is unavailable: ${esc(error.message)}`, "error")}`;
  }
}
