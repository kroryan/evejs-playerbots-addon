// Alliances: bot corporations banding together. Plans come from shared
// enemies (karma), from the empire at population, or from you: name, ticker,
// description, logo, the founding corporation and its allies. The founding
// CEO creates the alliance in game and the others join through the normal
// application, effective after 24 hours.

import { getJSON, postJSON } from "./api.js";
import { $, esc, toast, pageHead, emptyState, notice } from "./ui.js";

const MODES = ["Off (dashboard plans only)", "Karma: shared enemies ally", "Population: each empire bands together"];
const STATUS = { founding: ["warn", "Founding"], recruiting: ["warn", "Recruiting"], formed: ["good", "Formed"], "done-failed": ["bad", "Failed"] };
let data = null;
let logoDraft = "";
let editing = "";

async function load() {
  data = await getJSON("/api/alliances");
}

function corpLabel(entry) {
  return `${esc(entry.name)}${entry.ticker ? ` <span class="muted">[${esc(entry.ticker)}]</span>` : ""}`;
}

function designRow(design) {
  const [tone, label] = STATUS[design.status] || ["", design.status];
  return `<tr>
    <td>${design.logo ? `<img class="alliance-logo" src="${esc(design.logo)}" alt="">` : ""}</td>
    <td><strong>${esc(design.name)}</strong> <span class="muted">[${esc(design.ticker)}]</span><span class="sub">${esc(design.source)}</span></td>
    <td>${corpLabel(design.founder)}</td>
    <td>${design.members.map(corpLabel).join("<br>") || "—"}</td>
    <td><span class="pill ${tone}">${label}</span>${design.note ? `<span class="sub">${esc(design.note)}</span>` : ""}</td>
    <td class="row-actions"><button type="button" class="btn small" data-edit="${esc(design.id)}">Edit</button>${design.allianceID ? "" : ` <button type="button" class="btn small danger" data-delete="${esc(design.id)}">Remove</button>`}</td>
  </tr>`;
}

function form() {
  const design = data.designs.find((entry) => entry.id === editing) || null;
  const locked = Boolean(design && design.allianceID);
  const members = new Set(design ? design.members.map((entry) => entry.corporationID) : []);
  const options = data.corporations.map((entry) => `<option value="${entry.corporationID}"${design && design.founder.corporationID === entry.corporationID ? " selected" : ""}>${esc(entry.name)}${entry.allianceID ? " (in an alliance)" : ""}</option>`).join("");
  return `<div class="panel"><div class="panel-head"><h2>${design ? `Edit ${esc(design.name)}` : "Set up a bot alliance"}</h2></div><div class="panel-body alliance-form">
    <label>Name<input class="field" id="al-name" maxlength="50" list="al-names" value="${esc(design ? design.name : "")}"${locked ? " disabled" : ""}></label>
    <datalist id="al-names">${data.suggestedNames.map((entry) => `<option value="${esc(entry.name)}" data-ticker="${esc(entry.ticker)}">`).join("")}</datalist>
    <label>Ticker<input class="field" id="al-ticker" maxlength="5" value="${esc(design ? design.ticker : "")}"${locked ? " disabled" : ""}></label>
    <label>Description<textarea class="field" id="al-description" maxlength="1000" rows="2">${esc(design ? design.description || "" : "")}</textarea></label>
    <label>Founding corporation<select class="field" id="al-founder"${locked ? " disabled" : ""}><option value="">Choose…</option>${options}</select></label>
    <fieldset><legend>Allied corporations</legend><div class="alliance-members">${data.corporations.map((entry) => `<label><input type="checkbox" data-member="${entry.corporationID}"${members.has(entry.corporationID) ? " checked" : ""}> ${corpLabel(entry)}</label>`).join("")}</div></fieldset>
    <label>Logo (any image; saved as a 128 px PNG)<input type="file" id="al-logo" accept="image/*"></label>
    <div class="alliance-preview">${logoDraft || (design && design.logo) ? `<img class="alliance-logo big" src="${esc(logoDraft || design.logo)}" alt="Logo preview">` : ""}</div>
    <div class="head-actions"><button type="button" class="btn primary" id="al-save">${design ? "Save changes" : "Found this alliance"}</button>${design ? `<button type="button" class="btn" id="al-cancel">Cancel</button>` : ""}</div>
  </div></div>`;
}

function draw() {
  $("view").innerHTML = `${pageHead("flag", "Alliances", "Bot alliances: formed by shared enemies, by empire, or by you")}
    ${notice(`Alliance mode: <strong>${esc(MODES[data.mode] || "")}</strong> (change it in Settings → Headquarters). The founding corporation's CEO creates the alliance in game for the usual 1B ISK fee (the add-on hands it over); allies apply and join 24 hours after they are accepted.`, "info")}
    <div class="panel"><div class="panel-head"><h2>Alliance plans</h2></div>${data.designs.length
      ? `<div class="table-wrap"><table><thead><tr><th></th><th>Alliance</th><th>Founder</th><th>Allies</th><th>Status</th><th></th></tr></thead><tbody>${data.designs.map(designRow).join("")}</tbody></table></div>`
      : emptyState("flag", "No alliances yet", "Set one up below, or let shared enemies bring corporations together.")}</div>
    ${form()}`;
  wire();
}

function wire() {
  for (const button of document.querySelectorAll("[data-edit]")) button.addEventListener("click", () => { editing = button.dataset.edit; logoDraft = ""; draw(); });
  for (const button of document.querySelectorAll("[data-delete]")) button.addEventListener("click", () => send({ action: "delete", id: button.dataset.delete }));
  $("al-cancel")?.addEventListener("click", () => { editing = ""; logoDraft = ""; draw(); });
  $("al-name")?.addEventListener("change", (event) => {
    const match = data.suggestedNames.find((entry) => entry.name === event.target.value);
    if (match && !$("al-ticker").value) $("al-ticker").value = match.ticker;
  });
  $("al-logo")?.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) void readLogo(file);
  });
  $("al-save")?.addEventListener("click", () => send({
    action: editing ? "update" : "create",
    id: editing,
    name: $("al-name").value,
    ticker: $("al-ticker").value,
    description: $("al-description").value,
    founderCorporationID: Number($("al-founder").value) || 0,
    memberCorporationIDs: [...document.querySelectorAll("[data-member]:checked")].map((box) => Number(box.dataset.member)),
    logo: logoDraft,
  }));
}

// Any picture the browser can open, drawn into a 128 px square PNG.
async function readLogo(file) {
  try {
    // The page only allows data: images, so read the file as one.
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const side = Math.min(image.width, image.height);
    canvas.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128);
    logoDraft = canvas.toDataURL("image/png");
    const preview = document.querySelector(".alliance-preview");
    if (preview) preview.innerHTML = `<img class="alliance-logo big" src="${logoDraft}" alt="Logo preview">`;
  } catch {
    toast("That image could not be read.", "bad");
  }
}

async function send(body) {
  try {
    const result = await postJSON("/api/alliance-command", body);
    toast(result.message || "Done.", result.success === false ? "bad" : "good");
    if (result.success !== false) { editing = ""; logoDraft = ""; }
    await load();
    draw();
  } catch (error) {
    toast(String(error && error.message || error), "bad");
  }
}

export async function render(ctx) {
  if (ctx.fresh) {
    ctx.setCrumbs([{ label: "Alliances" }]);
    if (!data) $("view").innerHTML = pageHead("flag", "Alliances", "Loading…");
  }
  void ctx.loadSummary(false).catch(() => {});
  if (ctx.fresh || !data) {
    await load();
    draw();
  }
}
