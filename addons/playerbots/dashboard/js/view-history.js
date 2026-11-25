// History: the operation archive, newest first, with filters and details.

import { getJSON } from "./api.js";
import { $, esc, num, isk, when, pager, showDialog, coalesce, replaceKeepingFocus, corpLogo, pageHead, icon, emptyState, notice, toast, skeleton } from "./ui.js";
import { openPilot } from "./drawer.js";
import { downloadCSV, fetchAll, stamp } from "./csv.js";

const state = { page: 0, pageSize: 50, status: "", kind: "", search: "", data: null };

function statusClass(status) {
  const s = String(status).toLowerCase();
  if (["active", "running"].includes(s)) return "working";
  if (["holding", "review", "blocked"].includes(s)) return "holding";
  if (["failed", "error"].includes(s)) return "bad";
  if (["completed", "done", "finished"].includes(s)) return "good";
  return "idle";
}

const draw = coalesce(async () => {
  {
    const query = new URLSearchParams({ offset: String(state.page * state.pageSize), limit: String(state.pageSize) });
    if (state.status) query.set("status", state.status);
    if (state.kind) query.set("kind", state.kind);
    if (state.search) query.set("search", state.search);
    const data = await getJSON(`/api/operations?${query}`);
    if (!$("hist-table")) return;
    state.data = data;
    const statuses = Object.entries(data.counts || {}).sort();
    const kinds = Object.entries(data.kindCounts || {}).sort();
    const kindLabels = data.kindLabels || {};
    replaceKeepingFocus($("hist-filters"), `
      <input class="field" type="search" data-h="search" placeholder="Pilot, operation ID or action" value="${esc(state.search)}" style="min-width:260px" aria-label="Search operations">
      <select class="field" data-h="status" aria-label="Status"><option value="">All statuses</option>${statuses.map(([value, count]) => `<option value="${esc(value)}"${value === state.status ? " selected" : ""}>${esc(value)} (${num(count)})</option>`).join("")}</select>
      <select class="field" data-h="kind" aria-label="Operation type"><option value="">All operation types</option>${kinds.map(([value, count]) => `<option value="${esc(value)}"${value === state.kind ? " selected" : ""}>${esc(kindLabels[value] || value)} (${num(count)})</option>`).join("")}</select>`);
    const rows = data.rows || [];
    $("hist-table").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Updated</th><th>Pilot</th><th>Operation</th><th>Status</th><th>Where</th><th>Last step</th><th class="num">ISK</th><th></th></tr></thead>
      <tbody>${rows.map((op) => {
        const spent = Number(op.spent) || 0;
        const proceeds = Number(op.proceeds) || 0;
        return `<tr>
        <td class="nowrap">${when(op.updatedAt) || "—"}</td>
        <td><a href="#" data-pilot="${op.characterID}" class="link-strong"><strong>${esc(op.characterName || `Pilot ${op.characterID}`)}</strong></a><span class="sub">${corpLogo(op.corporationID, 14, "corp-logo inline")}${op.corporationTicker ? `[${esc(op.corporationTicker)}] ` : ""}${esc(op.corporationName || "")}</span></td>
        <td><strong>${esc(op.kindLabel || op.kind)}</strong>${op.stageLabel ? `<span class="sub">${esc(op.stageLabel)}</span>` : ""}</td>
        <td><span class="state ${statusClass(op.status)}">${esc(op.status)}</span></td>
        <td>${esc(op.systemName || (op.systemID ? `System ${op.systemID}` : "—"))}${op.shipName ? `<span class="sub">${esc(op.shipName)}</span>` : ""}</td>
        <td><span class="sub" style="color:var(--text-2);max-width:340px" title="${esc(op.lastAction || op.lastError || "")}">${esc(op.lastAction || op.lastError || "—")}</span></td>
        <td class="num nowrap">${spent ? `<span class="isk-out">−${esc(isk(spent))}</span>` : ""}${spent && proceeds ? "<br>" : ""}${proceeds ? `<span class="isk-in">+${esc(isk(proceeds))}</span>` : ""}${!spent && !proceeds ? "—" : ""}</td>
        <td><button class="btn small" type="button" data-op="${esc(op.operationID)}">${icon("info", { size: 16 })}<span>Details</span></button></td></tr>`;
      }).join("")}</tbody></table></div>
      ${rows.length ? "" : emptyState("history", "No operations match these filters", state.search || state.status || state.kind ? "Try clearing a filter." : "Operations appear here as pilots start work.")}
      ${pager(state.page, state.pageSize, Number(data.total) || 0, "hist")}`;
  }
});

// The archive row (names and labels) plus the full record from EveJS: a
// readable summary first, the raw record folded underneath for debugging.
async function showOperation(operationID) {
  const row = (state.data?.rows || []).find((candidate) => String(candidate.operationID) === String(operationID)) || {};
  try {
    const data = await getJSON(`/api/operation?operationID=${encodeURIComponent(operationID)}`);
    const op = data.operation || {};
    const raw = (v) => v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
    const fields = Object.keys(op).filter((key) => key !== "history" && !key.startsWith("_") && op[key] !== undefined);
    const history = Array.isArray(op.history) ? op.history : [];
    const spent = Number(row.spent ?? op.spent) || 0;
    const proceeds = Number(row.proceeds ?? op.proceeds) || 0;
    const pilotName = row.characterName || op.characterName || (op.characterID ? `Pilot ${op.characterID}` : "—");
    const summary = [
      ["Pilot", `${pilotName}${row.corporationName ? ` · ${row.corporationTicker ? `[${row.corporationTicker}] ` : ""}${row.corporationName}` : ""}`],
      ["Job", row.kindLabel || op.kind || "—"],
      ["Status", `${op.status || row.status || "—"}${row.stageLabel || op.stage ? ` · ${row.stageLabel || op.stage}` : ""}`],
      ["Where", row.systemName || (op.systemID ? `System ${op.systemID}` : "—")],
      ["Ship", row.shipName || "—"],
      ["Started", op.createdAt || op.startedAt ? when(op.createdAt || op.startedAt) : "—"],
      ["Updated", op.updatedAt ? when(op.updatedAt) : "—"],
      ["ISK", spent || proceeds ? `${spent ? `−${isk(spent)}` : ""}${spent && proceeds ? " / " : ""}${proceeds ? `+${isk(proceeds)}` : ""}` : "—"],
      ["Last step", row.lastAction || op.lastAction || "—"],
      ...(op.lastError || row.lastError ? [["Last error", op.lastError || row.lastError]] : []),
    ];
    showDialog(`${row.kindLabel || op.kind || "Operation"} · ${pilotName}`, `
      <div class="detail-grid">${summary.map(([label, value]) => `<div class="detail-row"><span>${esc(label)}</span><strong>${label === "Started" || label === "Updated" ? value : esc(value)}</strong></div>`).join("")}</div>
      <h3 style="margin:16px 0 8px">Steps (${num(history.length)})</h3>
      <ol class="timeline">${history.slice().reverse().map((h) => `<li><time>${esc(h.at ? new Date(h.at).toLocaleString() : "")}</time> <strong>${esc(h.stage || "")}</strong><div>${esc(h.message || "")}</div></li>`).join("") || "<li class='muted'>No steps recorded.</li>"}</ol>
      <details style="margin-top:14px"><summary class="muted">Full record (${esc(op.operationID || operationID)})</summary>
        <div class="detail-grid" style="margin-top:8px">${fields.map((key) => `<div class="detail-row"><span>${esc(key)}</span><strong>${esc(raw(op[key]))}</strong></div>`).join("")}</div></details>`);
  } catch (error) {
    showDialog("Operation", notice(esc(error.message), "error"));
  }
}

export async function render(ctx) {
  if (ctx.fresh || !$("hist-table")) {
    $("view").innerHTML = `${pageHead("history", "History", "Every operation, live and archived, newest first.", `<button class="btn" type="button" id="hist-export" title="Download every operation matching these filters">${icon("download")}<span>Export CSV</span></button>`)}
      <div class="panel"><div class="panel-body" style="padding-top:14px"><div class="toolbar" id="hist-filters"></div></div><div id="hist-table">${skeleton(1)}</div></div>`;
    $("hist-export").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const query = new URLSearchParams();
        if (state.status) query.set("status", state.status);
        if (state.kind) query.set("kind", state.kind);
        if (state.search) query.set("search", state.search);
        const rows = await fetchAll("/api/operations", query);
        downloadCSV(`playerbots-operations-${stamp()}.csv`, [
          { label: "Operation ID", value: (r) => r.operationID },
          { label: "Updated", value: (r) => r.updatedAt },
          { label: "Pilot", value: (r) => r.characterName },
          { label: "Character ID", value: (r) => r.characterID },
          { label: "Corporation", value: (r) => r.corporationName },
          { label: "Operation", value: (r) => r.kindLabel || r.kind },
          { label: "Status", value: (r) => r.status },
          { label: "Stage", value: (r) => r.stageLabel || r.stage },
          { label: "System", value: (r) => r.systemName },
          { label: "Ship", value: (r) => r.shipName },
          { label: "ISK spent", value: (r) => Number(r.spent) || 0 },
          { label: "ISK earned", value: (r) => Number(r.proceeds) || 0 },
          { label: "Last step", value: (r) => r.lastAction || r.lastError },
        ], rows);
        toast(`Downloaded ${num(rows.length)} operation${rows.length === 1 ? "" : "s"} as CSV.`, "good");
      } catch (error) {
        toast(`Could not export: ${error.message}`, "bad");
      } finally {
        button.disabled = false;
      }
    });
    let timer = null;
    $("hist-filters").addEventListener("input", (event) => {
      if (event.target.dataset.h !== "search") return;
      clearTimeout(timer);
      timer = setTimeout(() => { state.search = event.target.value.trim(); state.page = 0; void draw(); }, 400);
    });
    $("hist-filters").addEventListener("change", (event) => {
      const key = event.target.dataset.h;
      if (key === "status" || key === "kind") { state[key] = event.target.value; state.page = 0; void draw(); }
    });
    $("hist-table").addEventListener("click", (event) => {
      const op = event.target.closest("[data-op]");
      if (op) return void showOperation(op.dataset.op);
      const pilot = event.target.closest("[data-pilot]");
      if (pilot) { event.preventDefault(); return openPilot(Number(pilot.dataset.pilot)); }
      const page = event.target.closest("[data-page]");
      if (page) { state.page = Math.max(0, state.page + (page.dataset.page.endsWith("next") ? 1 : -1)); void draw(); }
    });
  }
  // The archive is large; refresh it on its own every minute at most.
  if (!ctx.fresh && state.loadedAt && Date.now() - state.loadedAt < 60_000) return;
  state.loadedAt = Date.now();
  await draw();
}
