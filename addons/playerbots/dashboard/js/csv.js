// CSV downloads of what a page lists, built in the browser.

import { getJSON } from "./api.js";
import { toast } from "./ui.js";

const MAX_ROWS = 5000;

export function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Formula-looking text is prefixed so spreadsheets show it as text.
  const numeric = typeof value === "number" || /^-?\d+(\.\d+)?$/.test(text);
  const safe = !numeric && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function downloadCSV(filename, columns, rows) {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(","));
  const blob = new Blob([`\ufeff${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Reads every page of a list endpoint (100 rows a request, the dashboard
// server's limit), up to MAX_ROWS.
export async function fetchAll(path, query) {
  const rows = [];
  let total = Infinity;
  for (let offset = 0; offset < Math.min(total, MAX_ROWS); offset += 100) {
    const params = new URLSearchParams(query);
    params.set("offset", String(offset));
    params.set("limit", "100");
    const data = await getJSON(`${path}?${params}`);
    total = Number(data.total) || 0;
    rows.push(...(data.rows || []));
    if (!(data.rows || []).length) break;
  }
  if (total > MAX_ROWS) toast(`Exported the first ${MAX_ROWS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows.`);
  return rows;
}

export function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}
