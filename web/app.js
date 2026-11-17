"use strict";
/* Bant Panosu UI. Plain JS, no libraries. Text coming from data is only ever written with textContent. */

const SVG_NS = "http://www.w3.org/2000/svg";
const { t, fmt, count } = window.PanoI18n;
let P = window.PanoTheme.palette(); // colors of the active theme, refreshed when the theme changes
const PACKET_SECONDS = 3.6;
const TAB_ORDER = ["pipelines", "sessions", "command", "graph", "agents", "tasks"];
const TAB_LABEL = () => ({ pipelines: t("Pipelines"), sessions: t("Sessions"), command: t("Command"), graph: t("Graph"), agents: t("Agents"), tasks: t("Tasks") });
const STATUS_LABEL = () => ({ done: t("done"), running: t("running"), error: t("error"), skipped: t("skipped"), waiting: t("waiting"), "not-run": t("not run"), "awaiting-approval": t("awaiting approval") });
const KIND_LABEL = () => ({ read: t("read"), write: t("write"), command: t("command"), web: t("web"), search: t("search"), agent: t("subagent"), skill: t("skill"), other: t("other") });
const statusText = (s) => STATUS_LABEL()[s] || s;
const statusColor = (s) => ({ done: P.done, running: P.run, error: P.err, skipped: P.skip, waiting: P.muted, "not-run": P.muted, "awaiting-approval": P.run }[s] || null);

const D = {
  tab: "pipelines", pipelinesOn: true, tasksOn: false, project: "", pipelinesNote: "", readOnly: false,
  pipelines: [], selPipeline: null, pipeline: null, pipelineSig: "", selRun: null, run: null, runSig: "", latestRun: null, selStep: null,
  scale: 0.8, message: null, confirm: null, modelChoice: {}, armGroups: [],
  sessions: [], selSession: null, session: null, sessionSig: "", sessionLoading: false, selAgent: "main",
  heatSort: "activity", heatSel: null, compareOpen: false, compareId: "", compare: null, compareLoading: false,
  subagents: null, subagentChoice: {}, subagentConfirm: null, subagentLoading: false,
  tasks: null, tasksTime: 0, tasksLoading: false, showDisabledTasks: true, tasksError: "",
};
let pollCount = 0;
let pollTimer = null;
let token = "";

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
function e(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "c") el.className = v;
    else if (k === "t") el.textContent = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sv(tag, props) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props || {})) el.setAttribute(k, v);
  return el;
}
function storeGet(k) { try { return localStorage.getItem("bp-" + k); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem("bp-" + k, v); } catch { /* storage may be blocked */ } }
const pad = (n) => (n < 10 ? "0" : "") + n;
const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
const clip = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const usdOrNone = (u) => (u == null ? t("no price") : fmt.usd(u));
const rgba = (hex, a) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
};

async function api(route, body) {
  const init = body ? { method: "POST", headers: { "content-type": "application/json", "x-pano-token": token }, body: JSON.stringify(body) } : {};
  let res;
  try { res = await fetch(route, init); } catch { throw new Error(t("Could not reach the server.")); }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON: the status code is reported below */ }
  if (!res.ok || (data && data.error)) throw new Error((data && data.error) || t("Request failed ({status})", { status: res.status }));
  return data;
}

/* ---------- messages and confirmation ---------- */
let messageTimer = null;
function showMessage(kind, text) {
  D.message = { kind, text };
  clearTimeout(messageTimer);
  if (kind === "ok") messageTimer = setTimeout(() => { D.message = null; renderMessage(); }, 5000);
  renderMessage();
}
function renderMessage() {
  const box = $("#message");
  box.replaceChildren();
  if (!D.message) return;
  box.append(e("div", { c: "msg " + D.message.kind }, e("span", { t: D.message.text }),
    e("button", { type: "button", "aria-label": t("Dismiss message"), t: t("Close"), onclick: () => { D.message = null; renderMessage(); } })));
}
function renderConfirm() {
  const box = $("#confirm");
  box.replaceChildren();
  if (D.confirm && D.confirm.kind === "pipeline") {
    box.append(e("div", { c: "confirm-row", role: "alertdialog", "aria-label": t("Confirm turning the pipeline off") },
      e("span", { c: "text", t: t("Turn pipeline {name} off? While it is off no step runs and runs wait for approval.", { name: D.selPipeline }) }),
      e("button", { type: "button", c: "btn danger", t: t("Turn pipeline off"), onclick: () => setPipelineSwitch(false) }),
      e("button", { type: "button", c: "btn", t: t("Cancel"), onclick: () => { D.confirm = null; renderConfirm(); } })));
  }
}

/* ---------- header, tabs, theme and language ---------- */
function availableTabs() {
  return TAB_ORDER.filter((a) => (a === "pipelines" ? D.pipelinesOn : a === "tasks" ? D.tasksOn : true));
}
function seg(label, options, current, onPick) {
  return e("div", { c: "seg", role: "group", "aria-label": label }, options.map(([value, text]) =>
    e("button", { type: "button", "aria-pressed": String(value === current), t: text, onclick: () => onPick(value) })));
}
function renderHeader() {
  $("#tabs").setAttribute("aria-label", t("View"));
  const nav = $("#tabs");
  nav.replaceChildren();
  const labels = TAB_LABEL();
  for (const id of availableTabs()) nav.append(e("button", { type: "button", c: "tab", "aria-current": D.tab === id ? "page" : null, t: labels[id], onclick: () => switchTab(id) }));
  $("#subtitle").textContent = (D.project ? D.project + " · " : "") + (D.pipelinesOn ? t("pipelines and session activity") : t("session activity"));
  const box = $("#controls");
  box.replaceChildren();
  if (D.tab === "pipelines" && D.pipeline && !D.readOnly) {
    const on = D.pipeline.enabled;
    box.append(e("button", { type: "button", c: "main-switch " + (on ? "on" : "off"), "aria-pressed": String(on), "aria-label": t("Main switch of pipeline {name}", { name: D.pipeline.name }), onclick: toggleMainSwitch },
      e("span", { c: "dot" }), e("span", { t: on ? t("PIPELINE ON") : t("PIPELINE OFF") }),
      e("span", { c: "rail", "aria-hidden": "true" }, e("span", { c: "knob" }))));
  }
  box.append(
    seg(t("Theme"), [["cream", "Cream"], ["neon", "Neon"]], window.PanoTheme.name, (v) => window.PanoTheme.set(v)),
    seg(t("Language"), [["en", "EN"], ["tr", "TR"]], window.PanoI18n.lang, (v) => window.PanoI18n.setLang(v)),
  );
}
window.PanoTheme.onChange(() => { P = window.PanoTheme.palette(); renderHeader(); switchTab(D.tab, true); });

// Command and Graph are separate modules (window.PanoCommand, window.PanoGraph).
let openModule = null;
function closeModule() {
  if (!openModule) return;
  const m = openModule === "command" ? window.PanoCommand : window.PanoGraph;
  try { if (m && typeof m.close === "function") m.close(); } catch { /* a module error must not stop the board */ }
  openModule = null;
}
async function ensureSessionList() {
  if (D.sessions.length) return;
  const v = await api("/api/sessions");
  D.sessions = v.sessions || [];
  renderSessionPicker();
  if (!D.selSession && D.sessions.length) D.selSession = D.sessions[0].id;
}
async function openModuleTab(id) {
  const root = $("#view-" + id);
  root.replaceChildren();
  const m = id === "command" ? window.PanoCommand : window.PanoGraph;
  if (!m || typeof m.open !== "function") { root.append(e("div", { c: "loading", t: t("This view could not be loaded ({file}).", { file: id === "command" ? "command.js" : "graph.js" }) })); return; }
  try { await ensureSessionList(); } catch { /* opens without a session list too */ }
  if (id === "graph" && D.pipelinesOn && !D.pipelines.length) { try { await loadPipelines(); } catch { /* opens without pipelines too */ } }
  if (D.tab !== id) return; // the user switched tabs while waiting
  const wrap = e("section", { c: "module", "aria-label": TAB_LABEL()[id] });
  root.append(wrap);
  openModule = id;
  try { m.open(wrap, id === "command" ? { sessionId: D.selSession } : { sessionId: D.selSession, pipeline: D.selPipeline }); }
  catch (err) { openModule = null; root.replaceChildren(e("div", { c: "loading", t: t("The view could not be opened: {error}", { error: err.message }) })); }
}
async function switchTab(id, force) {
  if (!availableTabs().includes(id)) id = D.pipelinesOn ? "pipelines" : "sessions";
  if (!force && id === D.tab) return;
  closeModule();
  D.tab = id;
  storeSet("tab", id);
  D.confirm = null;
  for (const a of TAB_ORDER) $("#view-" + a).hidden = a !== id;
  renderHeader(); renderConfirm();
  try {
    if (id === "pipelines") { renderPipelineView(); if (!D.pipelines.length) await loadPipelines(); refreshTasks(); }
    else if (id === "sessions") {
      renderSessionView();
      if (!D.sessions.length) await loadSessions(); else if (D.selSession && !D.session) await loadSession();
    }
    else if (id === "command" || id === "graph") await openModuleTab(id);
    else if (id === "agents") await openAgents();
    else if (id === "tasks") await openTasks();
  } catch (err) { showMessage("error", err.message); }
  schedulePoll();
}

/* ---------- pipelines: data ---------- */
async function loadPipelines() {
  const v = await api("/api/pipelines");
  D.pipelines = v.pipelines || [];
  renderPipelinePicker();
  if (!D.selPipeline && D.pipelines.length) {
    const remembered = storeGet("pipeline");
    await selectPipeline(D.pipelines.some((p) => p.name === remembered) ? remembered : D.pipelines[0].name);
  }
}
async function selectPipeline(name) {
  D.selPipeline = name; storeSet("pipeline", name);
  D.pipeline = null; D.pipelineSig = ""; D.selRun = null; D.run = null; D.runSig = ""; D.latestRun = null; D.selStep = null; D.confirm = null;
  D.scale = Number(storeGet("scale")) || 0.8;
  renderPipelinePicker(); renderHeader(); renderConfirm(); renderPipelineView();
  try { await loadPipeline(); } catch (err) { showMessage("error", err.message); }
}
async function loadPipeline() {
  const name = D.selPipeline;
  const v = await api("/api/pipeline?name=" + encodeURIComponent(name));
  if (D.selPipeline !== name) return;
  const sig = JSON.stringify(v);
  const first = !D.pipeline;
  const newest = v.runs && v.runs[0] ? v.runs[0].id : null;
  const hasNewRun = D.latestRun && newest && newest !== D.latestRun;
  D.latestRun = newest;
  let runChanged = false;
  if (!D.selRun || !(v.runs || []).some((r) => r.id === D.selRun) || hasNewRun) { D.selRun = newest; D.run = null; D.runSig = ""; runChanged = true; }
  if (sig === D.pipelineSig && !runChanged) return;
  D.pipelineSig = sig; D.pipeline = v;
  D.armGroups = groupArms(v);
  if (!D.selStep || !v.steps.some((a) => a.id === D.selStep)) D.selStep = v.steps[0] ? v.steps[0].id : null;
  if (D.selRun && !D.run) { try { await loadRun(true); } catch (err) { showMessage("error", err.message); } }
  if (first) D.scale = Number(storeGet("scale")) || (v.steps.length > 12 ? 0.6 : 1);
  renderHeader(); renderPipelineView();
}
async function loadRun(quiet) {
  const id = D.selRun;
  if (!id) { D.run = null; return; }
  const v = await api("/api/run?id=" + encodeURIComponent(id));
  if (D.selRun !== id) return;
  const sig = JSON.stringify(v);
  if (sig === D.runSig) return;
  D.runSig = sig; D.run = v;
  if (!quiet) renderPipelineView();
}
async function selectRun(id) {
  D.selRun = id; D.run = null; D.runSig = "";
  renderRunPicker();
  try { await loadRun(); } catch (err) { showMessage("error", err.message); }
}

/* ---------- pipelines: derived data ---------- */
function stepRecord(id) { return D.run && D.run.steps ? D.run.steps[id] || null : null; }
function stepStatus(id) {
  const r = stepRecord(id);
  if (r) return r.status;
  return D.run && D.run.status === "running" ? "waiting" : "not-run";
}
function groupArms(p) {
  const map = new Map();
  for (const k of p.edges || []) {
    const key = k.source + ">" + k.target;
    if (!map.has(key)) map.set(key, { source: k.source, target: k.target, labels: [], optional: true });
    const g = map.get(key);
    if (k.label && !g.labels.includes(k.label)) g.labels.push(k.label);
    if (!k.optional) g.optional = false;
  }
  return [...map.values()];
}
function layout(p) {
  const KW = 212, KH = 196, GX = 34, GY = 66, SRC_H = 74, EDGE = 40;
  const ordered = [...p.steps].sort((a, b) => a.order - b.order);
  const byId = new Map(ordered.map((a) => [a.id, a]));
  const incoming = new Map(ordered.map((a) => [a.id, []]));
  for (const k of D.armGroups) if (byId.has(k.target) && byId.has(k.source)) incoming.get(k.target).push(k.source);
  const layer = {};
  for (let round = 0; round <= ordered.length; round++) {
    let changed = false;
    for (const a of ordered) {
      let l = 1;
      for (const g of incoming.get(a.id)) l = Math.max(l, (layer[g] || 1) + 1);
      if (a.dependsOnAllPrevious) for (const o of ordered) if (o.order < a.order) l = Math.max(l, (layer[o.id] || 1) + 1);
      if (layer[a.id] !== l) { layer[a.id] = l; changed = true; }
    }
    if (!changed) break;
  }
  const layers = [];
  for (const a of ordered) (layers[layer[a.id] - 1] = layers[layer[a.id] - 1] || []).push(a);
  const widest = Math.max(1, ...layers.filter(Boolean).map((k) => k.length));
  const W = Math.max(900, widest * (KW + GX) + 2 * EDGE);
  const x = {}, y = {};
  layers.forEach((list, i) => {
    if (!list) return;
    const center = (a) => {
      const v = incoming.get(a.id).map((g) => x[g]).filter((n) => n != null);
      return v.length ? v.reduce((s, n) => s + n, 0) / v.length : W / 2;
    };
    if (i > 0) list.sort((p1, q) => center(p1) - center(q) || p1.order - q.order);
    list.forEach((a, j) => {
      x[a.id] = W / 2 + (j - (list.length - 1) / 2) * (KW + GX);
      y[a.id] = 20 + SRC_H + GY + i * (KH + GY);
    });
  });
  const H = 20 + SRC_H + GY + layers.length * (KH + GY);
  return { KW, KH, W, H, x, y, layer, SRC_H };
}

/* ---------- pipelines: rendering ---------- */
function renderPipelineView() {
  renderPipelinePicker(); renderRunPicker(); renderPipelineSummary(); renderPipelineTasks(); renderPipelineWarnings(); renderDiagram(); renderStepPanel();
}
function renderPipelinePicker() {
  const box = $("#pipeline-picker");
  box.replaceChildren(e("span", { c: "label", t: t("Pipeline") }));
  if (!D.pipelines.length) { box.append(e("span", { c: "muted", t: D.pipelinesOn ? t("Loading…") : "" })); return; }
  for (const p of D.pipelines) {
    const status = p.lastRun ? p.lastRun.status : null;
    box.append(e("button", { type: "button", c: "strip-btn", "aria-pressed": String(p.name === D.selPipeline), title: p.description || "", onclick: () => p.name !== D.selPipeline && selectPipeline(p.name) },
      e("span", { c: "lamp s-" + (status || "none"), "aria-hidden": "true" }),
      e("span", {}, p.name, e("span", { c: "sub", t: status ? statusText(status) + (p.lastRun.totalUsd != null ? " · " + t("last run {cost}", { cost: fmt.usd(p.lastRun.totalUsd) }) : "") : t("no runs") })),
      !p.enabled && e("span", { c: "pill off", t: t("off") }),
      p.error && e("span", { c: "pill off", t: t("broken") })));
  }
}
function renderRunPicker() {
  const box = $("#run-picker");
  box.replaceChildren(e("span", { c: "label", t: t("Run") }));
  const runs = D.pipeline ? D.pipeline.runs || [] : [];
  if (!runs.length) { box.append(e("span", { c: "muted", t: t("No runs recorded for this pipeline.") })); return; }
  for (const r of runs) {
    box.append(e("button", { type: "button", c: "strip-btn", "aria-pressed": String(r.id === D.selRun), onclick: () => r.id !== D.selRun && selectRun(r.id), title: r.id },
      e("span", { c: "lamp s-" + r.status, "aria-hidden": "true" }),
      e("span", {}, fmt.dateTime(r.createdAt), e("span", { c: "sub", t: statusText(r.status) + " · " + fmt.usd(r.totalUsd) }))));
  }
}
function statBox(label, value, note, color) {
  return e("div", { c: "stat" }, e("div", { c: "k", t: label }), e("div", { c: "v", t: value, style: color ? "color:" + color : null }), note ? e("div", { c: "n", t: note }) : null);
}
function renderPipelineSummary() {
  const box = $("#pipeline-summary");
  box.replaceChildren();
  const p = D.pipeline;
  if (!p) return;
  const agents = p.steps.filter((a) => a.kind === "agent").length;
  const off = p.steps.filter((a) => !a.enabled).length;
  const run = D.run;
  const durationMs = run ? (run.status === "running" ? Date.now() - Date.parse(run.createdAt) : Date.parse(run.updatedAt) - Date.parse(run.createdAt)) : null;
  box.append(
    statBox(t("Steps"), String(p.steps.length), t("{agents} agents, {tools} tools", { agents, tools: p.steps.length - agents })),
    statBox(t("Steps switched off"), String(off), off ? t("the pipeline runs with steps off") : t("all on"), off ? P.run : null),
    statBox(t("Selected run"), run ? statusText(run.status) : t("no run"), run ? t("duration {time}", { time: fmt.duration(durationMs) }) : t("never run"), run ? statusColor(run.status) : null),
    statBox(t("Cost of selected run"), run ? fmt.usd(run.totalUsd) : "-", run && run.note ? run.note : (D.selRun || "")),
  );
}
function renderPipelineWarnings() {
  const box = $("#pipeline-warnings");
  box.replaceChildren();
  const p = D.pipeline;
  if (!p) return;
  for (const w of p.warnings || []) box.append(e("div", { c: "msg warn", role: "note" }, e("span", { t: t("Warning: {text}", { text: w }) })));
  if (p.description) box.append(e("p", { c: "muted", style: "margin:4px 0 0", t: p.description }));
}
function renderPipelineTasks() {
  const box = $("#pipeline-tasks");
  box.replaceChildren();
  if (!D.tasksOn || !D.selPipeline || !D.tasks) return;
  const list = (D.tasks.tasks || []).filter((g) => g.pipeline === D.selPipeline);
  const row = e("div", { c: "pipeline-tasks", role: "note" }, e("span", { c: "col-label muted", t: t("Linked tasks") }));
  if (!list.length) row.append(e("span", { c: "muted small", t: t("No scheduled task is linked to this pipeline.") }));
  for (const g of list) row.append(e("span", { c: "tag" + (g.enabled ? " hot" : " dim"), t: g.name + " · " + (g.enabled ? t("ON") : t("OFF")) + " · " + t("next {time}", { time: g.enabled && g.next ? fmt.dateTime(g.next) : "-" }) }));
  box.append(row);
}
function armPath(x1, y1, x2, y2) {
  const dy = Math.max(40, (y2 - y1) * 0.5);
  return "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + dy) + " " + x2 + " " + (y2 - dy) + " " + x2 + " " + y2;
}
function scrollState(el) { return el ? [el.scrollLeft, el.scrollTop] : null; }
function legendBar(kind) {
  return e("div", { c: "legend-bar" },
    e("div", { c: "legend" }, kind === "pipeline"
      ? [e("span", {}, e("span", { c: "swatch in" }), t("into the selected step")), e("span", {}, e("span", { c: "swatch out" }), t("out of the selected step")), e("span", {}, e("span", { c: "swatch" }), t("other arms"))]
      : [e("span", {}, e("span", { c: "swatch write" }), t("file written")), e("span", {}, e("span", { c: "swatch read" }), t("file read"))]),
    e("div", { c: "zoom", role: "group", "aria-label": t("Zoom") }, [0.6, 0.8, 1].map((o) =>
      e("button", { type: "button", "aria-pressed": String(D.scale === o), "aria-label": t("Zoom {n}%", { n: o * 100 }), t: o * 100 + "%", onclick: () => { D.scale = o; storeSet("scale", String(o)); kind === "pipeline" ? renderDiagram() : renderSessionDiagram(); } }))));
}
function scaledFrame(W, H) {
  const scroll = e("div", { c: "diagram-scroll", tabindex: "0", role: "region", "aria-label": t("Diagram, scrollable") });
  const scale = e("div", { c: "diagram-scale", style: "width:" + W * D.scale + "px;height:" + H * D.scale + "px" });
  const diagram = e("div", { c: "diagram", style: "width:" + W + "px;height:" + H + "px;transform:scale(" + D.scale + ")" });
  scale.append(diagram); scroll.append(scale);
  return { scroll, diagram };
}
function makePacket(path, cls, i, style, text) {
  const el = e("div", { c: "packet " + cls, "aria-hidden": "true", t: text || null });
  const delay = -(((Date.now() / 1000) + i * 0.7) % PACKET_SECONDS).toFixed(2);
  el.style.cssText = "offset-path:path('" + path + "');animation-delay:" + delay + "s;" + (style || "");
  return el;
}

let arms = []; // {source, target, path element, packets, ...}
function renderDiagram() {
  const root = $("#pipeline-diagram");
  const prev = scrollState(root.querySelector(".diagram-scroll"));
  root.replaceChildren();
  arms = [];
  const p = D.pipeline;
  if (!p) { root.append(e("div", { c: "loading", t: D.selPipeline ? t("Loading pipeline…") : t("Choose a pipeline.") })); return; }
  root.append(legendBar("pipeline"));
  const L = layout(p);
  const { scroll, diagram } = scaledFrame(L.W, L.H);
  const svg = sv("svg", { width: L.W, height: L.H, viewBox: "0 0 " + L.W + " " + L.H });
  diagram.append(svg);
  // source node: the pipeline inputs
  const srcWidth = 340, srcX = L.W / 2 - srcWidth / 2;
  const inputNames = (p.inputs || []).map((g) => g.name);
  diagram.append(e("div", { c: "source-node", style: "left:" + srcX + "px;top:20px;width:" + srcWidth + "px;min-height:" + L.SRC_H + "px", title: (p.inputs || []).map((g) => g.name + ": " + g.description).join("\n") },
    e("b", { t: t("Inputs") }), e("div", { c: "chips" }, inputNames.length ? inputNames.map((g) => e("span", { c: "chip", t: g })) : e("span", { c: "chip", t: t("no inputs") }))));
  const srcBottom = 20 + L.SRC_H;
  const srcPoint = { x: L.W / 2, y: srcBottom };
  // arms: real edges plus first-layer steps that are not connected to the source
  const list = D.armGroups.filter((g) => (g.source === "input" || L.x[g.source] != null) && L.x[g.target] != null).map((g) => ({ ...g }));
  const hasIncoming = new Set(list.map((k) => k.target));
  for (const a of p.steps) if (!hasIncoming.has(a.id) && !a.dependsOnAllPrevious) list.push({ source: "input", target: a.id, labels: [], optional: true, thin: true });
  const packetLayer = e("div", { style: "position:absolute;inset:0;pointer-events:none" });
  list.forEach((k, i) => {
    const x1 = k.source === "input" ? srcPoint.x : L.x[k.source];
    const y1 = k.source === "input" ? srcPoint.y : L.y[k.source] + L.KH;
    const d = armPath(x1, y1, L.x[k.target], L.y[k.target]);
    const el = sv("path", { d, class: "arm" });
    svg.append(el);
    const srcStep = k.source === "input" ? null : p.steps.find((a) => a.id === k.source);
    const tgtStep = p.steps.find((a) => a.id === k.target);
    const srcStatus = k.source === "input" ? (D.run ? "done" : "not-run") : stepStatus(k.source);
    const tgtStatus = stepStatus(k.target);
    const flowing = !k.thin && p.enabled && (!srcStep || srcStep.enabled) && tgtStep.enabled && srcStatus === "done" && (tgtStatus === "done" || tgtStatus === "running");
    const rec = { ...k, el, flowing, active: flowing && tgtStatus === "running", dot: null, labeled: null };
    if (flowing) {
      rec.dot = makePacket(d, "dot", i, "");
      const label = k.labels.length ? k.labels[0] + (k.labels.length > 1 ? " +" + (k.labels.length - 1) : "") : t("data");
      rec.labeled = makePacket(d, "labeled", i, "background:" + P.colorOut, label);
      rec.labeled.style.display = "none";
      packetLayer.append(rec.dot, rec.labeled);
    }
    arms.push(rec);
  });
  diagram.append(packetLayer);
  for (const a of p.steps) diagram.append(stepCard(a, L.x[a.id] - L.KW / 2, L.y[a.id], L.KW, L.KH));
  root.append(scroll);
  if (prev) { scroll.scrollLeft = prev[0]; scroll.scrollTop = prev[1]; } else scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2;
  applyHighlight();
}
function stepCard(a, x, y, w, h) {
  const st = stepStatus(a.id), rec = stepRecord(a.id);
  const text = [statusText(st)];
  if (rec && rec.durationMs != null && st !== "waiting") text.push(fmt.duration(rec.durationMs));
  if (rec && rec.usd) text.push(fmt.usd(rec.usd));
  const badges = [];
  if (a.optional) badges.push(e("span", { c: "badge", t: t("optional") }));
  if (a.review) badges.push(e("span", { c: "badge", t: t("review") }));
  if (a.model && a.model.chain[0] && (a.model.paid || []).includes(a.model.chain[0])) badges.push(e("span", { c: "badge paid", t: t("paid") }));
  if (rec && rec.fellBack) badges.push(e("span", { c: "badge fallback", t: t("ran on fallback") }));
  const toggle = D.readOnly ? null : e("button", { type: "button", c: "toggle", "aria-pressed": String(a.enabled), "aria-label": t("Turn step {step} on or off ({id})", { step: a.executor, id: a.id }), onclick: () => toggleStep(a) },
    e("span", { c: "rail", "aria-hidden": "true" }, e("span", { c: "knob" })));
  const relation = e("span", { c: "relation", hidden: "" });
  const card = e("div", { c: "step-card", "data-id": a.id, style: "left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px" },
    e("div", { c: "card-top" }, e("span", { c: "lamp s-" + st, "aria-hidden": "true" }), e("span", { c: "num", t: pad(a.order) }), e("span", { c: "kind " + a.kind, t: a.kind === "agent" ? t("agent") : t("tool") }), toggle),
    e("button", { type: "button", c: "card-select", onclick: () => selectStep(a.id), "aria-label": t("{executor}, step {id}, show details", { executor: a.executor, id: a.id }) },
      e("span", { c: "card-name", t: a.executor }), e("span", { c: "card-id", t: a.id }), e("span", { c: "card-model", t: modelLabel(a), title: modelLabel(a) })),
    e("div", { c: "card-status st-" + st }, st === "error" ? e("span", { c: "err-tag", t: t("ERROR") }) : null, e("span", { t: (a.enabled ? "" : t("OFF") + " · ") + text.join(" · ") })),
    a.stats && a.stats.runs ? e("div", { c: "card-avg", t: t("avg {cost} · {n} runs", { cost: fmt.usd(a.stats.avgUsd), n: a.stats.runs }) }) : null,
    e("div", { c: "badges" }, badges), relation);
  if (!a.enabled) card.classList.add("off");
  return card;
}
function modelLabel(a) {
  if (!a.model) return t("code · no model");
  return a.model.tier ? t("tier: {tier}", { tier: a.model.tier }) : a.model.chain[0] || "-";
}
function selectStep(id, scrollTo) {
  D.selStep = id; D.confirm = D.confirm && D.confirm.kind === "model" ? null : D.confirm;
  applyHighlight(); renderStepPanel(); renderConfirm();
  if (scrollTo) { const card = document.querySelector('#pipeline-diagram .step-card[data-id="' + id + '"]'); if (card) card.scrollIntoView({ block: "nearest", inline: "nearest" }); }
}
function applyHighlight() {
  const sel = D.selStep;
  const feeders = new Set(), receivers = new Set();
  const svg = document.querySelector("#pipeline-diagram svg");
  const raised = [];
  for (const k of arms) {
    const inc = k.target === sel, out = k.source === sel;
    if (inc) feeders.add(k.source);
    if (out) receivers.add(k.target);
    k.el.setAttribute("class", "arm" + (k.flowing ? (k.active ? " active" : " flowing") : " dashed") + (k.thin ? " thin" : "") + (inc ? " incoming" : "") + (out ? " outgoing" : ""));
    if (inc || out) raised.push(k);
    if (k.labeled) {
      const show = inc || out;
      k.labeled.style.display = show ? "flex" : "none";
      k.labeled.style.background = inc ? P.colorIn : P.colorOut;
      k.dot.style.display = show ? "none" : "";
    }
  }
  for (const k of raised) svg.append(k.el);
  document.querySelectorAll("#pipeline-diagram .step-card").forEach((card) => {
    const id = card.dataset.id;
    const role = id === sel ? "selected" : (feeders.has(id) ? "feeds" : (receivers.has(id) ? "receives" : ""));
    card.classList.remove("selected", "feeds", "receives");
    if (role) card.classList.add(role);
    const rel = card.querySelector(".relation");
    rel.hidden = !role;
    rel.textContent = role === "selected" ? t("selected") : (role === "feeds" ? t("gives data to selected") : t("takes data from selected"));
    rel.style.background = role === "selected" ? P.sel : (role === "feeds" ? P.colorIn : P.colorOut);
    card.querySelector(".card-select").setAttribute("aria-pressed", String(id === sel));
  });
}

/* ---------- pipelines: switches ---------- */
async function toggleStep(a) {
  const next = !a.enabled;
  a.enabled = next;
  renderPipelineSummary(); renderDiagram(); renderStepPanel();
  try {
    await api("/api/switch", { pipeline: D.selPipeline, step: a.id, enabled: next });
    await loadPipeline(); loadPipelines().catch(() => {});
  } catch (err) {
    a.enabled = !next;
    renderPipelineSummary(); renderDiagram(); renderStepPanel();
    showMessage("error", t("Switch of {step} did not change: {error}", { step: a.executor, error: err.message }));
  }
}
function toggleMainSwitch() {
  if (!D.pipeline) return;
  if (D.pipeline.enabled) { D.confirm = { kind: "pipeline" }; renderConfirm(); } else setPipelineSwitch(true);
}
async function setPipelineSwitch(enabled) {
  D.confirm = null; renderConfirm();
  try {
    await api("/api/switch", { pipeline: D.selPipeline, enabled });
    await loadPipeline(); await loadPipelines();
    showMessage("ok", enabled ? t("Pipeline {name} turned on.", { name: D.selPipeline }) : t("Pipeline {name} turned off.", { name: D.selPipeline }));
  } catch (err) { showMessage("error", t("Pipeline switch did not change: {error}", { error: err.message })); }
}
async function saveModel() {
  const o = D.confirm;
  if (!o || o.kind !== "model") return;
  const body = o.isTier ? { agent: o.agent, tier: o.to } : { agent: o.agent, model: o.to };
  D.confirm = null; renderStepPanel();
  try {
    const r = await api("/api/model", body);
    delete D.modelChoice[o.step];
    await loadPipeline();
    renderStepPanel();
    showMessage("ok", t(o.isTier ? "Tier of agent {agent} saved: {from} → {to}." : "Model of agent {agent} saved: {from} → {to}.", { agent: o.agent, from: r.from || o.from, to: r.to || o.to }));
  } catch (err) { renderStepPanel(); showMessage("error", t("Model did not change: {error}", { error: err.message })); }
}

/* ---------- pipelines: detail panel ---------- */
function section(title, cls, ...content) { return e("div", { c: "section" }, e("h3", { c: cls || "", t: title }), ...content); }
function gotoButton(id, title, sub, cls) {
  return e("button", { type: "button", c: "goto " + (cls || ""), onclick: () => selectStep(id, true) }, e("span", { c: "b", t: title }), sub ? e("span", { c: "a", t: sub }) : null);
}
function impactText(a, p) {
  const targets = [...new Set(p.edges.filter((k) => k.source === a.id).map((k) => k.target))];
  const prefix = a.enabled ? "" : t("It is off right now. ");
  if (a.optional) {
    return [prefix + t("It is skipped and the pipeline continues."), targets.length ? t("These steps cannot receive its data: {list}.", { list: targets.join(", ") }) : t("No other step takes data from this step.")];
  }
  const later = p.steps.filter((x) => x.order > a.order).sort((x, y) => x.order - y.order).map((x) => x.id);
  return [prefix + t("The pipeline stops at this step and waits for approval."), later.length ? t("The next {n} steps will not run: {list}.", { n: later.length, list: later.join(", ") }) : t("No step runs after it.")];
}
function renderStepPanel() {
  const root = $("#pipeline-panel");
  const p = D.pipeline;
  root.replaceChildren();
  const a = p && p.steps.find((x) => x.id === D.selStep);
  if (!a) { root.append(e("div", { c: "note", t: p ? t("Select a step for details.") : t("Loading pipeline…") })); return; }
  const byId = new Map(p.steps.map((x) => [x.id, x]));
  const rec = stepRecord(a.id);
  root.append(e("div", { c: "section" },
    e("div", { c: "eyebrow", t: t("Step {n} · {id} · {kind}", { n: pad(a.order), id: a.id, kind: a.kind === "agent" ? t("agent") : t("tool") }) + (a.optional ? " · " + t("optional") : "") + (a.review ? " · " + t("review") : "") }),
    e("h2", { t: a.executor }),
    e("div", { c: "muted", t: a.description || "" }),
    e("div", { c: "path", t: a.definitionFile || "" })));
  if (rec) {
    const real = rec.actualModel && rec.actualModel !== rec.model ? " " + t("(actual: {model})", { model: rec.actualModel }) : "";
    root.append(e("div", { c: "note", t: t("In the selected run: ") + statusText(rec.status) + " · " + fmt.duration(rec.durationMs) + " · " + usdOrNone(rec.usd) + " · " + (rec.model || "-") + real + (rec.fellBack ? " · " + t("ran on a fallback model") : "") }));
    if (rec.error) root.append(e("div", { c: "msg error", t: t("Error: {text}", { text: rec.error }) }));
  }
  // where the data comes from
  const from = section(t("Where its data comes from"), "in");
  const constants = [];
  let n = 0;
  for (const g of a.inputs) {
    const src = g.source && byId.get(g.source);
    if (src) { n++; from.append(gotoButton(src.id, g.name + " ← " + src.executor + (g.field ? "." + g.field : "") + (g.optional ? " " + t("(optional)") : ""), g.expr, "in")); }
    else if (g.source === "input") { n++; from.append(e("div", { c: "note" }, e("span", { t: g.name + " ← " + t("pipeline input: ") + (g.field || "") }), e("div", { c: "path", t: g.expr }))); }
    else constants.push(g);
  }
  if (a.dependsOnAllPrevious) { n++; from.append(e("div", { c: "note", t: t("Receives the output of all previous steps.") })); }
  if (!n) from.append(e("div", { c: "note", t: t("Takes no data from other steps.") }));
  if (constants.length) from.append(e("div", { c: "muted small", t: t("Fixed values") }), e("div", { c: "table-wrap" }, e("table", {}, e("tbody", {}, constants.map((g) => e("tr", {}, e("td", { c: "mono", t: g.name }), e("td", { c: "mono", t: g.expr })))))));
  root.append(from, e("div", { c: "arrow", "aria-hidden": "true", t: "↓" }));
  // what it produces
  const produces = e("div", { c: "produces" }, e("div", { c: "small", t: t("This step produces") }));
  if (rec && rec.files && rec.files.length) {
    produces.append(...rec.files.map((d) => e("div", { c: "path", t: d.name + " · " + fmt.bytes(d.bytes) })));
    if (rec.folder) produces.append(e("div", { c: "path", t: rec.folder }));
  } else {
    produces.append(e("div", { c: "path", t: (a.produces || []).join(", ") || t("(no declared output)") }), e("div", { c: "small", t: rec ? t("No file record in the selected run.") : t("Not run in the selected run yet; files it is expected to produce.") }));
  }
  root.append(produces, e("div", { c: "arrow", "aria-hidden": "true", t: "↓" }));
  // where it goes
  const to = section(t("Who receives its data"), "out");
  const outgoing = D.armGroups.filter((k) => k.source === a.id && byId.has(k.target));
  for (const k of outgoing) to.append(gotoButton(k.target, byId.get(k.target).executor + (k.optional ? " " + t("(optional)") : ""), k.labels.join(", "), "out"));
  if (!outgoing.length) to.append(e("div", { c: "note", t: t("Gives data to no other step (end of the pipeline or a side output).") }));
  root.append(to);
  if (a.reads && a.reads.length) root.append(section(t("Files it reads"), "", a.reads.map((o) => e("div", { c: "path", t: o }))));
  const [k1, k2] = impactText(a, p);
  root.append(e("div", { c: "impact" }, e("h3", { t: t("What happens if you turn it off") }), e("div", { c: "k", t: k1 }), e("div", { c: "s", t: k2 })));
  root.append(modelSection(a, p));
  root.append(historySection(a));
}
function modelSection(a, p) {
  const box = section(t("Model"), "");
  if (!a.model) { box.append(e("div", { c: "note", t: t("This step is a tool: code runs, no model is used.") })); return box; }
  const m = a.model, isTier = !!m.tier;
  const current = isTier ? m.tier : m.chain[0];
  if (isTier) box.append(e("div", { c: "muted", t: t("Tier: {tier}. The chain comes from this tier.", { tier: m.tier }) }));
  box.append(e("ol", { c: "chain", "aria-label": t("Model chain") }, m.chain.map((x, i) =>
    e("li", { c: i === 0 ? "first" : "" }, e("span", { c: "badge", t: i === 0 ? t("1. primary") : t("{n}. fallback", { n: i + 1 }) }), x, (m.paid || []).includes(x) ? e("span", { c: "badge paid", t: t("paid") }) : null))));
  const options = isTier ? Object.keys(p.tiers || {}) : (p.models || []).map((x) => x.name);
  if (!options.includes(current)) options.unshift(current);
  const chosen = D.modelChoice[a.id] && options.includes(D.modelChoice[a.id]) ? D.modelChoice[a.id] : current;
  const selectId = "model-select";
  const select = e("select", { id: selectId, c: "select", disabled: D.readOnly ? "" : null, onchange: (ev) => { D.modelChoice[a.id] = ev.target.value; renderStepPanel(); document.getElementById(selectId).focus(); } },
    options.map((x) => {
      const paid = !isTier && (p.models || []).some((mm) => mm.name === x && mm.paid);
      return e("option", { value: x, selected: x === chosen ? true : null, t: x + (paid ? " " + t("(paid)") : "") + (x === current ? " · " + t("current") : "") });
    }));
  box.append(e("label", { for: selectId, c: "muted small", t: isTier ? t("Choose tier") : t("Choose primary model") }), select);
  if (isTier && chosen !== current) box.append(e("div", { c: "muted small", t: t("Models of tier {tier}:", { tier: chosen }) }), e("ol", { c: "chain" }, ((p.tiers || {})[chosen] || []).map((x, i) => e("li", { c: i === 0 ? "first" : "" }, e("span", { c: "badge", t: i === 0 ? t("1. primary") : t("{n}. fallback", { n: i + 1 }) }), x))));
  const pending = D.confirm && D.confirm.kind === "model" && D.confirm.step === a.id ? D.confirm : null;
  if (pending) {
    const users = (a.usedByPipelines || []).join(", ") || t("only this pipeline");
    box.append(e("div", { c: "confirm-row", role: "alertdialog", "aria-label": t("Confirm model change") },
      e("span", { c: "text", t: t(isTier ? "The tier of agent {agent} will change: {from} → {to}. Pipelines using this agent: {users}." : "The model of agent {agent} will change: {from} → {to}. Pipelines using this agent: {users}.", { agent: a.executor, from: pending.from, to: pending.to, users }) }),
      e("div", { c: "btn-row" }, e("button", { type: "button", c: "btn primary", t: t("Confirm"), onclick: saveModel }), e("button", { type: "button", c: "btn", t: t("Cancel"), onclick: () => { D.confirm = null; renderStepPanel(); } }))));
  } else if (!D.readOnly) {
    box.append(e("button", { type: "button", c: "btn primary", t: t("Save"), disabled: chosen === current ? "" : null, onclick: () => { D.confirm = { kind: "model", step: a.id, agent: a.executor, from: current, to: chosen, isTier }; renderStepPanel(); } }));
  }
  box.append(e("div", { c: "muted small", t: t("The choice is written to the agent file; other pipelines that use this agent are affected too.") }));
  return box;
}
function historySection(a) {
  const box = section(t("Recent runs"), "");
  const st = a.stats;
  if (st && st.runs) box.append(e("div", { c: "muted small", t: t("{n} runs · average {time} · average {cost}", { n: st.runs, time: fmt.duration(st.avgDurationMs), cost: fmt.usd(st.avgUsd) }) }));
  if (!a.history || !a.history.length) { box.append(e("div", { c: "note", t: t("No recorded runs.") })); return box; }
  box.append(e("div", { c: "table-wrap" }, e("table", {},
    e("thead", {}, e("tr", {}, [t("Date"), t("Status"), t("Model"), t("Duration"), t("Cost")].map((h) => e("th", { t: h })))),
    e("tbody", {}, a.history.map((g) => e("tr", {}, e("td", { t: fmt.dateTime(g.time) }), e("td", { c: "st-" + g.status, t: statusText(g.status) }), e("td", { c: "mono", t: g.model || "-" }), e("td", { t: fmt.duration(g.durationMs) }), e("td", { t: usdOrNone(g.usd) })))))));
  return box;
}

/* ---------- sessions: data ---------- */
async function loadSessions() {
  const v = await api("/api/sessions");
  D.sessions = v.sessions || [];
  D.sessionsFound = v.found !== false;
  renderSessionPicker();
  if (!D.selSession && D.sessions.length) await selectSession(D.sessions[0].id);
  else if (!D.sessions.length) renderSessionView();
}
async function selectSession(id) {
  D.selSession = id; D.session = null; D.sessionSig = ""; D.selAgent = "main"; D.heatSel = null;
  if (D.compareId === id) { D.compareId = ""; D.compare = null; }
  renderSessionPicker(); renderSessionView();
  await loadSession();
}
async function loadSession() {
  const id = D.selSession;
  if (!id || D.sessionLoading) return;
  D.sessionLoading = true;
  try {
    const v = await api("/api/session?id=" + encodeURIComponent(id));
    if (D.selSession !== id) return;
    const sig = JSON.stringify(v);
    if (sig === D.sessionSig) return;
    D.sessionSig = sig; D.session = v;
    if (!v.agents.some((a) => a.id === D.selAgent)) D.selAgent = "main";
    renderSessionView();
  } catch (err) { showMessage("error", err.message); if (!D.session) renderSessionView(); }
  finally { D.sessionLoading = false; }
}
function renderSessionPicker() {
  const box = $("#session-picker");
  box.replaceChildren(e("span", { c: "label", t: t("Session") }));
  if (!D.sessions.length) { box.append(e("span", { c: "muted", t: t("No recorded sessions for this project.") })); return; }
  for (const o of D.sessions) {
    box.append(e("button", { type: "button", c: "strip-btn", "aria-pressed": String(o.id === D.selSession), title: o.id, onclick: () => o.id !== D.selSession && selectSession(o.id) },
      e("span", {}, e("span", { t: o.title || o.id.slice(0, 8) }), e("span", { c: "sub", t: fmt.dateTime(o.startedAt) + " · " + fmt.bytes(o.bytes) + " · " + count(o.subagentCount, "{n} subagent", "{n} subagents") })),
      o.live && e("span", { c: "pill live", t: t("live") })));
  }
}
function collectFiles(s) {
  const files = { read: new Set(), write: new Set() };
  for (const a of s.agents) for (const d of a.files) { if (d.reads) files.read.add(d.path); if (d.writes) files.write.add(d.path); }
  return files;
}
function renderSessionView() {
  renderSessionPicker(); renderSessionToolbar(); renderSessionSummary(); renderCompare(); renderSessionDiagram(); renderSessionPanel(); renderSessionExtra();
  $("#session-footnote").textContent = t("Files written through Bash/PowerShell are not shown; only the command is.");
}
function renderSessionSummary() {
  const box = $("#session-summary");
  box.replaceChildren();
  const s = D.session;
  if (!s) return;
  const f = collectFiles(s);
  const tot = s.totals;
  box.append(
    statBox(t("API equivalent / USD"), fmt.usd(tot.usd), t("subscription usage is not billed"), P.read),
    statBox(t("Agents"), String(s.agents.length), t("including the main session")),
    statBox(t("Duration"), fmt.duration(s.durationMs), t("first to last record")),
    statBox(t("Model calls"), fmt.num(tot.calls)),
    statBox(t("Output tokens"), fmt.tokens(tot.output), t("input {n}", { n: fmt.tokens(tot.input) })),
    statBox(t("Read from cache"), fmt.tokens(tot.cacheRead), t("written {n}", { n: fmt.tokens(tot.cacheWrite) })),
    statBox(t("Redundant reads"), fmt.num(tot.redundantReads), t("re-reading a file nobody changed in between"), tot.redundantReads ? P.write : null),
    statBox(t("Errors"), fmt.num(tot.errors), tot.errors ? t("failed tool calls") : t("no errors recorded"), tot.errors ? P.err : null),
    statBox(t("Retries"), fmt.num(tot.retries), t("same tool called again after an error")),
    statBox(t("Files"), f.read.size + " / " + f.write.size, t("read / written")),
    statBox(t("Handoffs"), String((s.handoffs || []).length), t("one agent wrote, another read")),
  );
  if (s.live) box.append(e("div", { c: "stat" }, e("div", { c: "k", t: t("State") }), e("div", { c: "v", t: t("live") }), e("div", { c: "n", t: t("refreshes every 3 s") })));
}

/* ---------- sessions: diagram ---------- */
function sessionLayout(s) {
  const KW = 212, KH = 172, GX = 34, GY = 56, FP = 32, EDGE = 40;
  const many = s.agents.length > 12;
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  const root = byId.get("main") || s.agents[0];
  const parentOf = (a) => (a === root ? null : (a.parent && byId.has(a.parent) && a.parent !== a.id ? a.parent : root.id));
  const depth = new Map([[root.id, 0]]);
  const findDepth = (a, guard = 0) => {
    if (depth.has(a.id)) return depth.get(a.id);
    const d = guard > 100 ? 1 : findDepth(byId.get(parentOf(a)), guard + 1) + 1;
    depth.set(a.id, d); return d;
  };
  s.agents.forEach((a) => findDepth(a));
  const rank = new Map();
  const layers = [];
  for (const a of [...s.agents].sort((p, q) => (p.first || "").localeCompare(q.first || ""))) (layers[depth.get(a.id)] = layers[depth.get(a.id)] || []).push(a);
  const PER_ROW = 5;
  const rows = [];
  layers.forEach((list, d) => {
    if (!list) return;
    if (d > 0) list.sort((p, q) => (rank.get(parentOf(p)) || 0) - (rank.get(parentOf(q)) || 0) || (p.first || "").localeCompare(q.first || ""));
    list.forEach((a) => rank.set(a.id, rank.size));
    for (let i = 0; i < list.length; i += PER_ROW) rows.push(list.slice(i, i + PER_ROW));
  });
  const shownFiles = (a) => (!many || a.id === D.selAgent) ? a.files.slice().sort((p, q) => (q.writes * 2 + q.reads) - (p.writes * 2 + p.reads)) : [];
  const fileHeight = (a) => { const g = shownFiles(a); return g.length ? (Math.min(6, g.length) + (g.length > 6 ? 1 : 0)) * FP + 10 : 0; };
  const W = Math.max(720, Math.max(...rows.map((r) => r.length)) * (KW + GX) + 2 * EDGE);
  const place = {};
  let y = 20;
  for (const r of rows) {
    r.forEach((a, j) => { place[a.id] = { x: W / 2 + (j - (r.length - 1) / 2) * (KW + GX) - KW / 2, y }; });
    y += KH + Math.max(...r.map(fileHeight)) + GY;
  }
  return { KW, KH, FP, W, H: y, place, shownFiles, root, parentOf, byId, many };
}
function renderSessionDiagram() {
  const root = $("#session-diagram");
  const prev = scrollState(root.querySelector(".diagram-scroll"));
  root.replaceChildren();
  const s = D.session;
  if (!s) {
    root.append(e("div", { c: "loading", t: !D.sessions.length ? t("No session found for this project.") : t("Reading session… Large sessions can take a few seconds.") }));
    return;
  }
  root.append(legendBar("session"));
  const L = sessionLayout(s);
  const { scroll, diagram } = scaledFrame(L.W, L.H);
  const svg = sv("svg", { width: L.W, height: L.H, viewBox: "0 0 " + L.W + " " + L.H });
  diagram.append(svg);
  const packets = e("div", { style: "position:absolute;inset:0;pointer-events:none" });
  const nodes = [];
  let n = 0;
  for (const a of s.agents) {
    const pos = L.place[a.id];
    if (!pos) continue;
    const files = L.shownFiles(a);
    const shown = files.slice(0, 6);
    const parent = a === L.root ? null : L.byId.get(L.parentOf(a));
    if (parent) {
      const q = L.place[parent.id];
      const x1 = q.x + (L.shownFiles(parent).length ? L.KW - 16 : L.KW / 2);
      const d = armPath(x1, q.y + L.KH, pos.x + L.KW / 2, pos.y);
      svg.append(sv("path", { d, class: "arm" + (a.finished === false || s.live ? " flowing" : " dashed") }));
      if (s.live && a.finished === false) packets.append(makePacket(d, "dot", n++, "background:" + P.colorOut));
    }
    const flows = s.live || a.id === D.selAgent;
    shown.forEach((d, i) => {
      const dy = pos.y + L.KH + 10 + i * L.FP;
      const armD = "M " + (pos.x + 6) + " " + (pos.y + L.KH) + " V " + (dy + 5) + " Q " + (pos.x + 6) + " " + (dy + 13) + " " + (pos.x + 18) + " " + (dy + 13) + " H " + (pos.x + 24);
      svg.append(sv("path", { d: armD, class: "arm" + (flows ? " flowing" : " dashed") }));
      if (flows && d.writes) packets.append(makePacket(armD, "dot", n++, "background:" + P.write));
      if (flows && d.reads) packets.append(makePacket(armD, "dot reverse", n++, "background:" + P.read));
      const mode = d.writes && d.reads ? "rw" : (d.writes ? "w" : "r");
      nodes.push(e("div", { c: "file-node " + mode, title: d.path + " · " + t("reads {n}", { n: d.reads }) + " · " + t("writes {n}", { n: d.writes }), style: "left:" + (pos.x + 24) + "px;top:" + dy + "px;width:" + (L.KW - 60) + "px" },
        e("span", { c: "nm", t: baseName(d.path) }), e("span", { c: "ic", t: mode === "rw" ? "R+W" : mode.toUpperCase(), style: "color:" + (mode === "r" ? P.read : mode === "w" ? P.write : P.text) })));
    });
    if (files.length > 6) {
      const dy = pos.y + L.KH + 10 + 6 * L.FP;
      nodes.push(e("div", { c: "file-node more", style: "left:" + (pos.x + 24) + "px;top:" + dy + "px;width:" + (L.KW - 60) + "px" }, e("span", { c: "nm", t: t("+{n} more files", { n: files.length - 6 }) })));
    }
    nodes.push(sessionAgentCard(a, pos.x, pos.y, L.KW, L.KH, s));
  }
  diagram.append(packets, ...nodes);
  root.append(scroll);
  if (prev) { scroll.scrollLeft = prev[0]; scroll.scrollTop = prev[1]; } else scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2;
}
function sessionAgentCard(a, x, y, w, h, s) {
  const st = a.finished === true || !s.live ? "done" : "running";
  const models = a.models.map((m) => m.model).join(", ") || (a.requestedModel || "-");
  const output = a.models.reduce((sum, m) => sum + m.output, 0);
  const c = a.counts;
  const hasErrors = c.errors > 0;
  const lit = D.heatSel ? heatAgents(s) : null;
  return e("div", { c: "agent-card" + (a.id === D.selAgent ? " selected" : "") + (lit ? (lit.has(a.id) ? " highlight" : " dim") : ""), style: "left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px" },
    e("div", { c: "name-row" }, e("span", { c: "lamp s-" + st, "aria-hidden": "true" }), e("span", { c: "name", t: a.name }), e("span", { c: "muted small", t: a.id === "main" ? "" : (st === "done" ? t("done") : t("running")) }),
      hasErrors ? e("span", { c: "err-tag", title: t("{n} failed tool calls", { n: c.errors }), t: t("ERROR") + " " + c.errors }) : null),
    e("div", { c: "desc", t: a.description || (a.id === "main" ? t("The main session that talks to the user") : "") }),
    e("div", { c: "line", title: models, t: models }),
    e("div", { c: "line", t: t("read {r} · write {w} · cmd {c} · web {x}", { r: c.read, w: c.write, c: c.command, x: c.web }) }),
    e("div", { c: "line", t: t("output {n} tokens", { n: fmt.tokens(output) }) }),
    e("div", { c: "line usd", t: t("API equivalent {cost}", { cost: usdOrNone(a.usd) }) }),
    e("button", { type: "button", c: "agent-select", "aria-pressed": String(a.id === D.selAgent), "aria-label": a.name + (a.description ? ": " + a.description : "") + ", " + t("show details"), onclick: () => { D.selAgent = a.id; renderSessionDiagram(); renderSessionPanel(); } }));
}

/* ---------- sessions: detail panel ---------- */
function renderSessionPanel() {
  const root = $("#session-panel");
  root.replaceChildren();
  const s = D.session;
  const a = s && s.agents.find((x) => x.id === D.selAgent);
  if (!a) { root.append(e("div", { c: "note", t: s ? t("Select an agent for details.") : t("Waiting for session…") })); return; }
  const kinds = KIND_LABEL();
  root.append(e("div", { c: "section" },
    e("div", { c: "eyebrow", t: (s.live ? t("live session") + " · " : "") + a.id + (a.parent ? " · " + t("parent: {id}", { id: a.parent }) : "") }),
    e("h2", { t: a.name }),
    a.description && e("div", { c: "muted", t: a.description }),
    e("div", { c: "tags" },
      e("span", { c: "tag", t: t("requested model: {model}", { model: a.requestedModel || "-" }) }), e("span", { c: "tag", t: t("effort: {effort}", { effort: a.effort || "-" }) }),
      e("span", { c: "tag", t: a.finished === true ? t("done") : (a.finished === false ? t("running") : t("main session")) }), e("span", { c: "tag", t: fmt.time(a.first) + " – " + fmt.time(a.last) }),
      e("span", { c: "tag", t: t("API equivalent: {cost}", { cost: usdOrNone(a.usd) }) }),
      a.counts.errors ? e("span", { c: "err-tag", t: t("ERROR") + " " + a.counts.errors }) : null)));
  root.append(section(t("Model and tokens"), "", e("div", { c: "table-wrap" }, e("table", {},
    e("thead", {}, e("tr", {}, [t("Model"), t("Calls"), t("Input"), t("Output"), t("Cache read"), t("Cache write"), t("API $")].map((h, i) => e("th", { c: i ? "right" : "", t: h })))),
    e("tbody", {}, a.models.map((m) => e("tr", {}, e("td", { c: "mono", t: m.model }), [m.calls, m.input, m.output, m.cacheRead, m.cacheWrite].map((v, i) => e("td", { c: "right", t: i === 0 ? fmt.num(v) : fmt.tokens(v) })), e("td", { c: "right", t: usdOrNone(m.usd) }))))))));
  const c = a.counts;
  root.append(section(t("Tool use"), "", e("div", { c: "tags" }, [[t("tools"), c.tools], [t("reads"), c.read], [t("writes"), c.write], [t("commands"), c.command], [t("web"), c.web], [t("searches"), c.search], [t("subagents"), c.agent]].map(([name, v]) => e("span", { c: "tag", t: name + " " + v })))));
  const files = [...a.files].sort((p, q) => (q.writes * 2 + q.reads) - (p.writes * 2 + p.reads));
  root.append(section(t("Files ({n})", { n: a.fileCount }), "", files.length ? e("div", { c: "table-wrap tall" }, e("table", {},
    e("thead", {}, e("tr", {}, e("th", { t: t("Path") }), e("th", { c: "right", t: t("Reads") }), e("th", { c: "right", t: t("Writes") }))),
    e("tbody", {}, files.slice(0, 300).map((d) => e("tr", {}, e("td", { c: "path-cell", t: d.path }), e("td", { c: "right", t: String(d.reads) }), e("td", { c: "right", t: String(d.writes) })))))) : e("div", { c: "note", t: t("This agent did not read or write any file.") }),
    files.length > 300 ? e("div", { c: "muted small", t: t("Showing the first 300 files of {n}.", { n: files.length }) }) : null));
  const events = [...a.events].reverse().slice(0, 200);
  root.append(section(t("Timeline (newest first)"), "", events.length ? e("ul", { c: "timeline" }, events.map((ev) =>
    e("li", { c: ev.error ? "err" : "" }, e("span", { c: "s", t: fmt.time(ev.time) }), e("span", { c: "t", t: (kinds[ev.kind] || ev.kind) + " · " + ev.tool, style: "color:" + (P.kind[ev.kind] || P.kind.other) }),
      e("span", { c: "o" }, ev.summary || "", ev.error ? e("span", { c: "err-text" }, e("span", { c: "err-tag", t: t("ERROR") }), " " + clip(ev.error, 400)) : null)))) : e("div", { c: "note", t: t("No events.") }),
    a.events.length > 200 ? e("div", { c: "muted small", t: t("Showing the last 200 events of {n}.", { n: a.events.length }) }) : null));
  const handoffs = (s.handoffs || []).filter((h) => h.writer === a.id || h.reader === a.id);
  const nameOf = (id) => (s.agents.find((x) => x.id === id) || { name: id }).name;
  root.append(section(t("Handoffs ({n})", { n: handoffs.length }), "", handoffs.length ? e("div", { c: "table-wrap tall" }, e("table", {},
    e("tbody", {}, handoffs.slice(0, 200).map((h) => e("tr", {}, e("td", { t: fmt.time(h.time) }), e("td", { t: t("{writer} wrote → {reader} read", { writer: nameOf(h.writer), reader: nameOf(h.reader) }) }), e("td", { c: "path-cell", t: h.path })))))) : e("div", { c: "note", t: t("This agent is not part of any handoff.") })));
}

/* ---------- sessions: helpers ---------- */
function heatAgents(s) {
  const r = (s.fileHeat || []).find((x) => x.path === D.heatSel);
  return r ? new Set(r.agents) : null;
}
function agentName(s, id) { const a = s.agents.find((x) => x.id === id); return a ? a.name : id; }
function shortId(a) { return a.id === "main" ? t("main session") : a.id.slice(0, 8); }
function makeBox(title, ...content) { return e("section", { c: "box", "aria-label": title }, e("h3", { c: "box-title", t: title }), ...content); }

/* ---------- sessions: cost, file heat map, errors ---------- */
function renderSessionExtra() {
  const root = $("#session-extra");
  if (!D.session) { root.replaceChildren(); return; }
  if (root.children.length !== 4) root.replaceChildren(e("div", { id: "extra-cost" }), e("div", { id: "extra-models" }), e("div", { id: "extra-heat" }), e("div", { id: "extra-errors" }));
  renderCost(); renderModelCost(); renderHeat(); renderErrors();
}
function costRow(name, sub, usd, max, cls, onclick) {
  const body = onclick
    ? e("button", { type: "button", c: "cost-name", onclick, "aria-label": name + ", " + t("select agent") }, e("b", { t: name }), e("span", { t: sub }))
    : e("div", { c: "cost-name" }, e("b", { t: name }), e("span", { t: sub }));
  return e("li", { c: "cost-row" }, body,
    e("div", { c: "bar-track", "aria-hidden": "true" }, e("div", { c: "bar " + (cls || ""), style: "width:" + Math.max(usd > 0 ? 0.8 : 0, usd / max * 100).toFixed(2) + "%" })),
    e("span", { c: "cost-amount", t: fmt.usd(usd) }));
}
function renderCost() {
  const root = $("#extra-cost");
  root.replaceChildren();
  const s = D.session;
  if (!s) return;
  const pr = s.pricing || {};
  const box = makeBox(t("Cost by agent"));
  if ((pr.unpriced || []).length) box.append(e("div", { c: "msg warn", role: "note" }, e("span", { t: t("Warning: models without a price: {list}. Their cost is not in the totals; the real equivalent may be higher. Add them to prices.json.", { list: pr.unpriced.join(", ") }) })));
  const total = s.totals.usd || 0;
  const list = s.agents.map((a) => ({ a, usd: a.usd || 0 })).sort((p, q) => q.usd - p.usd);
  const top = list.slice(0, 10), rest = list.slice(10);
  const restUsd = rest.reduce((sum, x) => sum + x.usd, 0);
  const max = Math.max(1e-9, top.length ? top[0].usd : 0, restUsd);
  const ul = e("ul", { c: "cost-list", "aria-label": t("API equivalent of the agents, highest first") });
  for (const { a, usd } of top) {
    const share = total > 0 ? " · " + fmt.pct(usd / total) : "";
    ul.append(costRow(a.name, shortId(a) + " · " + (a.models.map((m) => m.model).join(", ") || "-") + share, usd, max, "", () => { D.selAgent = a.id; renderSessionDiagram(); renderSessionPanel(); }));
  }
  if (rest.length) ul.append(costRow(t("others"), t("{n} agents", { n: rest.length }) + (total > 0 ? " · " + fmt.pct(restUsd / total) : ""), restUsd, max, "other", null));
  box.append(e("div", { c: "box-note", t: t("Total API equivalent {cost}. Click an agent to show it in the detail panel.", { cost: fmt.usd(total) }) }), ul,
    e("div", { c: "box-note", t: (pr.note ? t("API list-price equivalent; subscription usage is not billed per token") : "") + (pr.source ? " · " + t("price source: {source}", { source: pr.source }) : "") }));
  root.append(box);
}
function renderModelCost() {
  const root = $("#extra-models");
  root.replaceChildren();
  const s = D.session;
  if (!s) return;
  const byModel = new Map();
  for (const a of s.agents) for (const m of a.models) {
    const r = byModel.get(m.model) || { calls: 0, output: 0, usd: 0, unpriced: false };
    r.calls += m.calls; r.output += m.output;
    if (m.usd == null) r.unpriced = true; else r.usd += m.usd;
    byModel.set(m.model, r);
  }
  const rows = [...byModel.entries()].sort((p, q) => q[1].usd - p[1].usd || q[1].calls - p[1].calls);
  const total = s.totals.usd || 0;
  const max = Math.max(1e-9, ...rows.map(([, r]) => r.usd));
  const box = makeBox(t("Cost by model"));
  if (!rows.length) { box.append(e("div", { c: "note", t: t("No model usage recorded.") })); root.append(box); return; }
  const ul = e("ul", { c: "cost-list", "aria-label": t("API equivalent per model, highest first") });
  for (const [model, r] of rows) {
    ul.append(costRow(model, t("{calls} calls · {tokens} output tokens", { calls: fmt.num(r.calls), tokens: fmt.tokens(r.output) }) + (r.unpriced ? " · " + t("no price") : (total > 0 ? " · " + fmt.pct(r.usd / total) : "")), r.usd, max, "", null));
  }
  box.append(e("div", { c: "box-note", t: t("The same total split by model, across all agents of this session.") }), ul);
  root.append(box);
}
function renderHeat() {
  const root = $("#extra-heat");
  const previous = root.querySelector(".heat-list");
  const scroll = previous ? previous.scrollTop : 0;
  root.replaceChildren();
  const s = D.session;
  if (!s) return;
  const act = (d) => d.reads + d.writes;
  const compare = {
    activity: (p, q) => act(q) - act(p) || q.writes - p.writes,
    redundant: (p, q) => q.redundantReads - p.redundantReads || act(q) - act(p),
    writes: (p, q) => q.writes - p.writes || act(q) - act(p),
  };
  const sortLabels = { activity: t("Activity"), redundant: t("Redundant reads"), writes: t("Writes") };
  const files = (s.fileHeat || []).slice().sort(compare[D.heatSort] || compare.activity);
  const max = Math.max(1, ...files.map(act));
  const box = makeBox(t("File heat map"));
  box.append(e("div", { c: "box-note", t: t("Activity = reads + writes; the bar is relative to the most active file. Redundant read: re-reading a file nobody changed in between. At most 200 files.") }));
  box.append(e("div", { c: "sort-row", role: "group", "aria-label": t("Sort") }, e("span", { c: "col-label muted", t: t("Sort") }),
    Object.entries(sortLabels).map(([k, name]) => e("button", { type: "button", c: "btn", "data-sort": k, "aria-pressed": String(D.heatSort === k), t: name,
      onclick: () => { D.heatSort = k; renderHeat(); const b = document.querySelector('[data-sort="' + k + '"]'); if (b) b.focus(); } }))));
  const lit = D.heatSel ? heatAgents(s) : null;
  if (lit) {
    box.append(e("div", { c: "heat-agents" }, e("span", { c: "col-label", t: t("Agents that touched this file") }),
      [...lit].map((id) => e("span", { c: "tag hot", t: agentName(s, id) + (id === "main" ? "" : " · " + id.slice(0, 8)) })),
      e("button", { type: "button", c: "btn", t: t("Clear highlight"), onclick: () => { D.heatSel = null; renderSessionDiagram(); renderHeat(); } })));
  }
  if (!files.length) { box.append(e("div", { c: "note", t: t("No file activity in this session.") })); root.append(box); return; }
  const list = e("div", { c: "heat-list", role: "table", "aria-label": t("File activity") },
    e("div", { c: "heat-head", role: "row" }, [t("Path"), t("Reads"), t("Writes"), t("Redundant"), t("Errors"), t("Agents")].map((h) => e("span", { role: "columnheader", t: h }))));
  for (const d of files) {
    const alpha = Math.min(0.34, act(d) / max * 0.34);
    const selected = D.heatSel === d.path;
    const cell = (v, bad) => e("span", { role: "cell", c: v ? (bad ? "bad" : "") : "zero", t: String(v) });
    list.append(e("div", { c: "heat-row" + (selected ? " selected" : ""), role: "row", title: t("first {a} · last {b}", { a: fmt.dateTime(d.first), b: fmt.dateTime(d.last) }),
      style: "background:linear-gradient(90deg," + rgba(P.accent, alpha.toFixed(3)) + " " + (act(d) / max * 100).toFixed(1) + "%,transparent " + (act(d) / max * 100).toFixed(1) + "%)" },
      e("div", { role: "cell" }, e("button", { type: "button", c: "heat-path", "aria-pressed": String(selected), "aria-label": d.path + ", " + t("highlight the agents that touched this file"),
        onclick: () => { D.heatSel = selected ? null : d.path; renderSessionDiagram(); renderHeat(); const b = document.querySelector('.heat-path[aria-pressed="true"]'); if (b) b.focus({ preventScroll: true }); } }, d.path)),
      cell(d.reads), cell(d.writes), cell(d.redundantReads, true), cell(d.errors, true), cell(d.agents.length)));
  }
  box.append(list);
  root.append(box);
  list.scrollTop = scroll;
}
function renderErrors() {
  const root = $("#extra-errors");
  root.replaceChildren();
  const s = D.session;
  if (!s) return;
  const errors = (s.errors || []).slice().reverse();
  const retries = (s.retries || []).slice().reverse();
  const box = makeBox(t("Errors"));
  box.append(e("div", { c: "box-note", t: t("{errors} errors, {retries} retries", { errors: fmt.num(s.totals.errors), retries: fmt.num(s.totals.retries) }) + (errors.length < s.totals.errors ? "; " + t("showing the last {n} errors.", { n: errors.length }) : ".") }));
  if (!errors.length) box.append(e("div", { c: "note", t: t("No errors in this session.") }));
  else box.append(e("ul", { c: "error-list", "aria-label": t("Latest errors, newest first") }, errors.slice(0, 30).map((h) =>
    e("li", { c: "error-row" }, e("span", { c: "z", t: fmt.time(h.time) }),
      e("div", { c: "g" }, e("div", { c: "b" }, e("span", { c: "err-tag", t: t("ERROR") }), e("b", { t: agentName(s, h.agent) }), e("span", { c: "mono muted", t: h.tool })),
        e("div", { c: "o", t: clip(h.summary, 200) }), e("div", { c: "h", t: clip(h.error, 400) }))))));
  box.append(e("h3", { c: "box-title", t: t("Retries") }));
  if (!retries.length) box.append(e("div", { c: "note", t: t("No retries.") }));
  else box.append(e("div", { c: "table-wrap tall" }, e("table", {},
    e("thead", {}, e("tr", {}, [t("Last"), t("Agent"), t("Tool"), t("Summary"), t("Attempts"), t("Outcome")].map((h, i) => e("th", { c: i === 4 ? "right" : "", t: h })))),
    e("tbody", {}, retries.slice(0, 30).map((d) => e("tr", {},
      e("td", { t: fmt.time(d.last) }), e("td", { t: agentName(s, d.agent) }), e("td", { c: "mono", t: d.tool }), e("td", { c: "wrap mono", t: clip(d.summary, 120) }), e("td", { c: "right", t: String(d.attempts) }),
      e("td", {}, d.outcome === "success" ? e("span", { c: "ok-text", t: t("succeeded") }) : e("span", { c: "err-tag", t: t("ERROR") }))))))));
  root.append(box);
}

/* ---------- sessions: compare ---------- */
function renderSessionToolbar() {
  const box = $("#session-toolbar");
  box.replaceChildren();
  if (!D.sessions.length) return;
  box.append(e("button", { type: "button", c: "btn", "aria-pressed": String(D.compareOpen), t: t("Compare"), onclick: toggleCompare }));
  if (!D.compareOpen) return;
  const others = D.sessions.filter((o) => o.id !== D.selSession);
  box.append(e("label", { for: "compare-select", c: "col-label muted", t: t("Second session (B)") }),
    e("select", { id: "compare-select", c: "select narrow", onchange: (ev) => selectCompare(ev.target.value) },
      e("option", { value: "", t: t("Choose") }),
      others.map((o) => e("option", { value: o.id, selected: o.id === D.compareId ? true : null, t: (o.title || o.id.slice(0, 8)) + " · " + fmt.dateTime(o.startedAt) }))),
    e("button", { type: "button", c: "btn", t: t("Close"), onclick: closeCompare }));
}
function toggleCompare() { if (D.compareOpen) closeCompare(); else { D.compareOpen = true; renderSessionToolbar(); renderCompare(); const s = $("#compare-select"); if (s) s.focus(); } }
function closeCompare() { D.compareOpen = false; D.compareId = ""; D.compare = null; renderSessionToolbar(); renderCompare(); }
async function selectCompare(id) {
  D.compareId = id; D.compare = null;
  renderCompare();
  if (!id) return;
  D.compareLoading = true; renderCompare();
  try {
    const v = await api("/api/session?id=" + encodeURIComponent(id));
    if (D.compareId !== id) return;
    D.compare = v;
  } catch (err) { showMessage("error", t("Could not read the second session: {error}", { error: err.message })); }
  finally { D.compareLoading = false; renderCompare(); }
}
const fileSetCache = new WeakMap();
function fileSet(s) {
  if (fileSetCache.has(s)) return fileSetCache.get(s);
  const m = new Map();
  for (const a of s.agents) for (const d of a.files) m.set(d.path, (m.get(d.path) || 0) + d.reads + d.writes);
  fileSetCache.set(s, m);
  return m;
}
function compareMetrics(s) {
  const tt = s.totals;
  return { duration: s.durationMs, calls: tt.calls, output: tt.output, cache: tt.cacheRead, usd: tt.usd, errors: tt.errors, retries: tt.retries, redundant: tt.redundantReads, files: fileSet(s).size, subagents: Math.max(0, s.agents.length - 1) };
}
// [label, key, format, lowerIsBetter]: when lowerIsBetter is false no direction is marked
const compareRows = () => [
  [t("Duration"), "duration", fmt.duration, true], [t("Model calls"), "calls", fmt.num, true], [t("Output tokens"), "output", fmt.tokens, true],
  [t("Read from cache"), "cache", fmt.tokens, false], [t("API equivalent"), "usd", fmt.usd, true], [t("Errors"), "errors", fmt.num, true],
  [t("Retries"), "retries", fmt.num, true], [t("Redundant reads"), "redundant", fmt.num, true], [t("File count"), "files", fmt.num, true], [t("Subagent count"), "subagents", fmt.num, true],
];
function diffText(a, b, lowerIsBetter) {
  if (a === b) return { text: t("equal"), good: null };
  const big = Math.max(a, b), ratio = big > 0 ? Math.abs(a - b) / big : 0;
  const less = a < b ? "A" : "B";
  if (!lowerIsBetter) return { text: t("{side} {pct} more (direction not marked: more cache can be good)", { side: a > b ? "A" : "B", pct: fmt.pct(ratio) }), good: null };
  return { text: t("{side} is better: {pct} less", { side: less, pct: fmt.pct(ratio) }), good: less };
}
function modelSplit(s) {
  const m = new Map();
  for (const a of s.agents) for (const x of a.models) {
    const r = m.get(x.model) || { calls: 0, usd: 0, unpriced: false };
    r.calls += x.calls; if (x.usd == null) r.unpriced = true; else r.usd += x.usd;
    m.set(x.model, r);
  }
  return m;
}
function renderCompare() {
  const root = $("#session-compare");
  root.replaceChildren();
  if (!D.compareOpen) return;
  const A = D.session;
  const box = makeBox(t("Session comparison"));
  if (!A) { box.append(e("div", { c: "loading", t: t("Reading session A…") })); root.append(box); return; }
  if (!D.compareId) { box.append(e("div", { c: "note", t: t("Choose a second session (B) above to compare.") })); root.append(box); return; }
  const B = D.compare;
  if (!B) { box.append(e("div", { c: "loading", t: D.compareLoading ? t("Reading session B… Large sessions can take a few seconds.") : t("Session B could not be loaded.") })); root.append(box); return; }
  const nameA = (D.sessions.find((x) => x.id === D.selSession) || {}).title || A.title || A.id.slice(0, 8);
  const nameB = (D.sessions.find((x) => x.id === D.compareId) || {}).title || B.title || B.id.slice(0, 8);
  const mA = compareMetrics(A), mB = compareMetrics(B);
  box.append(e("div", { c: "box-note", t: t("In every row less is better, except cache reads where no direction is marked. File count is the number of different files the agents read or wrote.") }));
  const rows = compareRows().map(([label, key, format, lower]) => {
    const f = diffText(mA[key] || 0, mB[key] || 0, lower);
    return e("tr", {}, e("td", { t: label }), e("td", { c: "right" + (f.good === "A" ? " good" : ""), t: format(mA[key] || 0) }), e("td", { c: "right" + (f.good === "B" ? " good" : ""), t: format(mB[key] || 0) }), e("td", { c: "diff" + (f.good ? "" : " muted"), t: f.text }));
  });
  box.append(e("div", { c: "table-wrap" }, e("table", { c: "compare-table" },
    e("thead", {}, e("tr", {}, e("th", { t: t("Metric") }), e("th", { c: "right", title: nameA, t: "A: " + clip(nameA, 26) }), e("th", { c: "right", title: nameB, t: "B: " + clip(nameB, 26) }), e("th", { t: t("Difference") }))),
    e("tbody", {}, rows))));
  const dA = modelSplit(A), dB = modelSplit(B);
  const totalA = A.totals.calls || 1, totalB = B.totals.calls || 1;
  const models = [...new Set([...dA.keys(), ...dB.keys()])].sort((p, q) => ((dB.get(q) || { calls: 0 }).calls + (dA.get(q) || { calls: 0 }).calls) - ((dB.get(p) || { calls: 0 }).calls + (dA.get(p) || { calls: 0 }).calls));
  const cells = (r, total) => r ? [e("td", { c: "right", t: fmt.num(r.calls) + " (" + fmt.pct(r.calls / total) + ")" }), e("td", { c: "right", t: r.unpriced ? t("no price") : fmt.usd(r.usd) })] : [e("td", { c: "right muted", t: "-" }), e("td", { c: "right muted", t: "-" })];
  box.append(e("h3", { c: "box-title", t: t("Model split") }), e("div", { c: "table-wrap" }, e("table", {},
    e("thead", {}, e("tr", {}, [t("Model"), t("A calls (share)"), t("A API $"), t("B calls (share)"), t("B API $")].map((h, i) => e("th", { c: i ? "right" : "", t: h })))),
    e("tbody", {}, models.map((m) => e("tr", {}, e("td", { c: "mono", t: m }), cells(dA.get(m), totalA), cells(dB.get(m), totalB)))))));
  const kA = fileSet(A), kB = fileSet(B);
  const both = [], onlyA = [], onlyB = [];
  for (const [p, n] of kA) (kB.has(p) ? both : onlyA).push([p, n + (kB.get(p) || 0)]);
  for (const [p, n] of kB) if (!kA.has(p)) onlyB.push([p, n]);
  const byCount = (l) => l.sort((p, q) => q[1] - p[1]);
  const region = (title, l) => e("div", { c: "mini-box" }, e("h4", { t: title + " (" + l.length + ")" }),
    ...(l.length ? [...byCount(l).slice(0, 20).map(([p]) => e("div", { c: "path", t: p })), l.length > 20 ? e("div", { c: "muted small", t: t("+{n} more files", { n: l.length - 20 }) }) : null] : [e("div", { c: "muted small", t: t("none") })]));
  box.append(e("h3", { c: "box-title", t: t("File overlap") }), e("div", { c: "compare-regions" }, region(t("Both"), both), region(t("Only A"), onlyA), region(t("Only B"), onlyB)));
  root.append(box);
}

/* ---------- agents tab (Claude Code subagent settings) ---------- */
async function loadSessionForUsage() {
  try { await ensureSessionList(); if (D.selSession && !D.session) await loadSession(); } catch { /* works without usage data too */ }
}
async function openAgents() {
  renderAgents();
  D.subagentLoading = true;
  try {
    const [settings] = await Promise.all([api("/api/subagents"), loadSessionForUsage()]);
    D.subagents = settings;
  } finally { D.subagentLoading = false; }
  renderAgents();
}
function modelMatches(requested, actual) {
  if (!requested || requested === "inherit") return true;
  return String(actual).toLowerCase().includes(String(requested).toLowerCase());
}
function subagentUsage(name, fileModel) {
  const s = D.session;
  if (!s) return null;
  const list = s.agents.filter((a) => a.id !== "main" && a.name === name);
  const models = new Map();
  const requested = new Set();
  let usd = 0;
  for (const a of list) {
    if (a.requestedModel) requested.add(a.requestedModel);
    usd += a.usd || 0;
    for (const m of a.models) {
      const r = models.get(m.model) || { calls: 0, usd: 0, unpriced: false };
      r.calls += m.calls; if (m.usd == null) r.unpriced = true; else r.usd += m.usd;
      models.set(m.model, r);
    }
  }
  if (!requested.size && fileModel && fileModel !== "inherit") requested.add(fileModel);
  const warnings = [];
  for (const r of requested) if ([...models.keys()].length && ![...models.keys()].some((g) => modelMatches(r, g))) warnings.push(t("Requested model ({requested}) differs from the actual model ({actual}).", { requested: r, actual: [...models.keys()].join(", ") }));
  return { n: list.length, usd, models, requested: [...requested], warnings };
}
function subagentCard(a) {
  const written = a.modelWritten ? a.model : "inherit";
  const options = (D.subagents.models || []).slice();
  if (!options.includes(written)) options.unshift(written);
  const chosen = D.subagentChoice[a.file] && options.includes(D.subagentChoice[a.file]) ? D.subagentChoice[a.file] : written;
  const id = "sub-model-" + a.file.replace(/[^a-z0-9]/gi, "-");
  const pending = D.subagentConfirm && D.subagentConfirm.file === a.file ? D.subagentConfirm : null;
  const refresh = () => { const old = document.querySelector('[data-file="' + CSS.escape(a.file) + '"]'); if (old) old.replaceWith(subagentCard(a)); };
  const usage = subagentUsage(a.name, a.model);
  const use = e("div", { c: "usage" }, e("span", { c: "col-label muted", t: t("Use in the selected session") }));
  if (!D.session) use.append(e("span", { c: "muted", t: D.selSession ? t("Reading session…") : t("No session selected.") }));
  else if (!usage.n) use.append(e("span", { c: "muted", t: t("Not used in this session.") }));
  else {
    use.append(e("span", { t: t("Used {n} times · total API equivalent {cost}", { n: usage.n, cost: fmt.usd(usage.usd) }) }));
    for (const [m, r] of usage.models) use.append(e("span", { c: "mono", t: m + " · " + t("{n} calls", { n: fmt.num(r.calls) }) + " · " + (r.unpriced ? t("no price") : fmt.usd(r.usd)) }));
    if (usage.requested.length) use.append(e("span", { c: "muted", t: t("requested model: {model}", { model: usage.requested.join(", ") }) }));
    for (const u of usage.warnings) use.append(e("div", { c: "warn-line", role: "note", t: t("Warning: {text}", { text: u }) }));
  }
  return e("article", { c: "agent-settings", "data-file": a.file },
    e("div", { c: "field-row" }, e("h2", { t: a.name }), e("div", { c: "path", t: a.file })),
    e("div", { c: "desc", title: a.description || "", t: a.description || t("No description.") }),
    e("div", { c: "tags" }, e("span", { c: "tag", t: t("model: {model}", { model: written }) }), e("span", { c: "tag", t: t("effort: {effort}", { effort: a.effort || "-" }) })),
    e("div", { c: "tags", "aria-label": t("Tools") }, (a.tools || []).length ? a.tools.map((x) => e("span", { c: "tag", t: x })) : e("span", { c: "muted small", t: t("No tool list (all tools).") })),
    a.modelWritten ? null : e("div", { c: "note", t: t("The file has no model line, so it defaults to inherit; saving adds one.") }),
    e("div", { c: "field-row" }, e("label", { for: id, c: "col-label muted", t: t("Model") }),
      e("select", { id, c: "select", disabled: D.readOnly ? "" : null, onchange: (ev) => { D.subagentChoice[a.file] = ev.target.value; D.subagentConfirm = null; refresh(); const s = document.getElementById(id); if (s) s.focus(); } },
        options.map((x) => e("option", { value: x, selected: x === chosen ? true : null, t: x + (x === written ? " · " + t("current") : "") })))),
    pending
      ? e("div", { c: "confirm-row", role: "alertdialog", "aria-label": t("Confirm subagent model change") },
        e("span", { c: "text", t: t("The model of {agent} will change: {from} → {to}; file: {file}", { agent: a.name, from: pending.from, to: pending.to, file: a.file }) }),
        e("div", { c: "btn-row" }, e("button", { type: "button", c: "btn primary", t: t("Confirm"), onclick: () => saveSubagentModel(pending) }), e("button", { type: "button", c: "btn", t: t("Cancel"), onclick: () => { D.subagentConfirm = null; refresh(); } })))
      : (D.readOnly ? null : e("button", { type: "button", c: "btn primary", t: t("Save"), disabled: chosen === written ? "" : null, onclick: () => { D.subagentConfirm = { file: a.file, name: a.name, from: written, to: chosen }; refresh(); } })),
    use);
}
async function saveSubagentModel(o) {
  D.subagentConfirm = null;
  try {
    const r = await api("/api/subagent-model", { file: o.file, model: o.to });
    delete D.subagentChoice[o.file];
    D.subagents = await api("/api/subagents");
    renderAgents();
    showMessage("ok", t("Model of {agent} saved: {from} → {to}.", { agent: o.name, from: r.from || o.from, to: r.to || o.to }));
  } catch (err) { renderAgents(); showMessage("error", t("Subagent model did not change: {error}", { error: err.message })); }
}
function renderAgents() {
  const top = $("#agents-top"), list = $("#agents-list");
  top.replaceChildren(); list.replaceChildren();
  const cfg = D.subagents;
  if (!cfg) { list.append(e("div", { c: "loading", t: D.subagentLoading ? t("Reading subagent settings…") : t("Subagent settings could not be loaded.") })); return; }
  const current = D.sessions.find((x) => x.id === D.selSession);
  top.append(e("div", { c: "box-note", t: t("Subagent models are read from the files under {folder}; saving changes the model line in the file.", { folder: cfg.folder || t("the subagent folder") }) + " " + t("Usage comes from the selected session{name}. Use the Sessions tab to choose a session.", { name: current ? ": " + (current.title || current.id.slice(0, 8)) : "" }) }));
  if (!cfg.folder || !(cfg.agents || []).length) { list.append(e("div", { c: "note", t: t("No subagent definitions found in this project (.claude/agents/*.md).") })); return; }
  for (const a of cfg.agents) list.append(subagentCard(a));
}

/* ---------- tasks tab (Windows Task Scheduler, optional) ---------- */
const RESULT_CODES = () => ({ 0: [t("succeeded"), "ok-text"], 267011: [t("never ran"), ""], 267009: [t("running now"), ""], 267014: [t("stopped (0x41306)"), "bad-text"] });
function taskResult(g) {
  if (g.state === "Running") return [t("running now"), ""];
  if (g.result == null) return ["-", ""];
  return RESULT_CODES()[g.result] || [t("failed, code 0x{code}", { code: (g.result >>> 0).toString(16).toUpperCase() }), "bad-text"];
}
async function loadTasks(quiet) {
  if (D.tasksLoading) return;
  D.tasksLoading = true;
  try {
    D.tasks = await api("/api/tasks"); D.tasksTime = Date.now(); D.tasksError = "";
  } catch (err) { D.tasksError = err.message; if (!quiet) { D.tasksLoading = false; renderTasks(); throw err; } }
  finally { D.tasksLoading = false; }
  if (D.tab === "tasks") renderTasks();
  if (D.tab === "pipelines") renderPipelineTasks();
}
function refreshTasks() { if (D.tasksOn && Date.now() - D.tasksTime > 55000) loadTasks(true).catch(() => {}); }
async function openTasks() { renderTasks(); await loadTasks(); }
async function goToPipeline(name) {
  await switchTab("pipelines");
  if (D.pipelines.some((p) => p.name === name)) { if (D.selPipeline !== name) await selectPipeline(name); }
  else showMessage("warn", t("Pipeline {name} not found.", { name }));
}
function renderTasks() {
  const top = $("#tasks-top"), strip = $("#tasks-strip"), list = $("#tasks-list");
  top.replaceChildren(); strip.replaceChildren(); list.replaceChildren();
  const v = D.tasks;
  if (!v) { list.append(e("div", { c: "loading", t: D.tasksError ? t("Could not read tasks: {error}", { error: D.tasksError }) : t("Loading tasks… the scheduler query can take 1-2 s.") })); return; }
  if (v.supported === false) { list.append(e("div", { c: "note", t: t("The task scheduler cannot be read on this machine.") })); return; }
  const all = v.tasks || [];
  const enabled = all.filter((g) => g.enabled).sort((p, q) => (p.next ? Date.parse(p.next) : Infinity) - (q.next ? Date.parse(q.next) : Infinity));
  const disabled = all.filter((g) => !g.enabled).sort((p, q) => p.name.localeCompare(q.name));
  top.append(e("div", { c: "toolbar" },
    e("span", { c: "tag hot", t: t("ON") + " " + enabled.length }), e("span", { c: "tag dim", t: t("OFF") + " " + disabled.length }),
    e("button", { type: "button", c: "btn", "aria-pressed": String(D.showDisabledTasks), t: t("Show disabled"), onclick: () => { D.showDisabledTasks = !D.showDisabledTasks; renderTasks(); const b = [...document.querySelectorAll("#tasks-top .btn")][0]; if (b) b.focus(); } }),
    D.tasksError ? e("span", { c: "err-tag", t: t("COULD NOT REFRESH") }) : null),
  e("div", { c: "box-note", t: t("The board does not turn tasks on or off; manage them in Task Scheduler.") + (v.folder ? " " + t("Folder: {folder}", { folder: v.folder }) : "") }));
  renderTimeStrip(strip, enabled);
  list.append(e("div", { c: "task-head", "aria-hidden": "true" }, [t("Task"), t("State"), t("Last run"), t("Result"), t("Next"), t("Pipeline"), t("Command")].map((h) => e("span", { t: h }))));
  for (const g of enabled.concat(D.showDisabledTasks ? disabled : [])) list.append(taskRow(g));
}
function taskRow(g) {
  const [resultText, resultClass] = taskResult(g);
  const field = (label, ...content) => e("div", {}, e("span", { c: "m-label", t: label }), ...content);
  const pipelineCell = g.pipeline
    ? (D.pipelinesOn ? e("button", { type: "button", c: "goto-pipeline", title: t("Show pipeline {name}", { name: g.pipeline }), "aria-label": t("Show pipeline {name} in the Pipelines tab", { name: g.pipeline }), onclick: () => goToPipeline(g.pipeline), t: g.pipeline }) : e("span", { t: g.pipeline }))
    : e("span", { c: "muted", t: "-" });
  return e("div", { c: "task" + (g.enabled ? "" : " off") },
    e("div", { c: "name-cell" }, e("span", { c: "name", t: g.name })),
    field(t("State"), e("span", { c: "state-tag" + (g.enabled ? " on" : ""), t: g.enabled ? t("ON") : t("OFF") })),
    field(t("Last run"), e("span", { c: "when", t: g.last ? fmt.dateTime(g.last) : "-" })),
    field(t("Result"), e("span", { c: "when " + resultClass, t: resultText })),
    field(t("Next"), e("span", { c: "when", t: g.next && g.enabled ? fmt.dateTime(g.next) : "-" })),
    field(t("Pipeline"), pipelineCell),
    e("div", { c: "cmd-cell" }, e("span", { c: "m-label", t: t("Command") }), e("div", { c: "cmd", t: g.command || "-" })));
}
function renderTimeStrip(root, enabled) {
  const now = Date.now(), end = now + 24 * 3600e3, span = end - now;
  const at = (ms) => ((ms - now) / span * 100).toFixed(2) + "%";
  const groups = new Map();
  for (const g of enabled) {
    if (!g.next) continue;
    const ms = Date.parse(g.next);
    if (!(ms >= now - 60000 && ms <= end)) continue;
    const minute = Math.round(ms / 60000);
    if (!groups.has(minute)) groups.set(minute, { ms, names: [] });
    groups.get(minute).names.push(g.name);
  }
  const list = [...groups.values()].sort((p, q) => p.ms - q.ms);
  const hhmm = (ms) => new Date(ms).toLocaleTimeString(window.PanoI18n.locale, { hour: "2-digit", minute: "2-digit" });
  const summary = list.length ? list.map((x) => hhmm(x.ms) + " " + x.names.join(", ")).join("; ") : t("no tasks planned in the next 24 hours");
  const track = e("div", { c: "track", role: "img", "aria-label": t("Enabled tasks in the next 24 hours: {summary}", { summary }) });
  track.append(e("div", { c: "now", style: "left:0" }), e("span", { c: "now-label", t: t("NOW {time}", { time: hhmm(now) }) }));
  const firstHour = new Date(now); firstHour.setMinutes(0, 0, 0); firstHour.setHours(firstHour.getHours() + 1);
  for (let ms = firstHour.getTime(); ms < end; ms += 3600e3) {
    const h = new Date(ms).getHours();
    track.append(e("span", { c: "tick", style: "left:" + at(ms) }));
    if (h % 3 === 0) track.append(e("span", { c: "tick-label", style: "left:" + at(ms), t: pad(h) + ":00" }));
  }
  list.forEach((x, i) => {
    const lane = i % 3, top = lane * 22;
    track.append(e("span", { c: "mark", style: "left:" + at(Math.max(now, x.ms)) + ";height:" + (86 - top - 18) + "px" }));
    track.append(e("span", { c: "mark-label", title: x.names.join(", "), style: "left:" + at(Math.max(now, x.ms)) + ";top:" + top + "px", t: hhmm(x.ms) + (x.names.length > 1 ? " ×" + x.names.length : "") }));
  });
  root.append(e("section", { c: "time-strip", "aria-label": t("Next 24 hours") }, e("h3", { c: "box-title", t: t("Next 24 hours") }), track,
    e("div", { c: "tags", style: "margin-top:30px" }, list.length ? list.map((x) => e("span", { c: "tag", t: hhmm(x.ms) + " · " + x.names.join(", ") })) : e("span", { c: "muted small", t: t("No enabled task is planned in the next 24 hours.") }))));
}

/* ---------- polling ---------- */
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  let ms;
  if (D.tab === "pipelines") ms = D.run && D.run.status === "running" ? 2000 : 10000;
  else if (D.tab === "sessions") ms = D.session && D.session.live ? 3000 : 15000;
  else if (D.tab === "tasks") ms = 30000;
  else return; // command and graph poll on their own; the agents tab is not polled
  pollTimer = setTimeout(async () => { try { await poll(); } catch { /* quiet; retried on the next round */ } schedulePoll(); }, ms);
}
async function poll() {
  pollCount++;
  if (D.tab === "pipelines") {
    if (!D.selPipeline) return;
    if (D.run && D.run.status === "running") {
      await loadRun(true);
      renderRunDetails();
      if (D.run && D.run.status !== "running") { await loadPipeline(); await loadPipelines(); }
    } else {
      await loadPipeline();
      if (D.selRun) { const before = D.runSig; await loadRun(true); if (before !== D.runSig) renderPipelineView(); }
      if (pollCount % 3 === 0) await loadPipelines();
    }
    refreshTasks();
  } else if (D.tab === "sessions") {
    if (D.selSession) await loadSession();
    if (!D.session || !D.session.live) { const before = D.sessions.length; await loadSessions(); if (before !== D.sessions.length) renderSessionPicker(); }
  } else if (D.tab === "tasks") {
    await loadTasks(true);
  }
}
let lastRunDetailSig = "";
function renderRunDetails() {
  if (lastRunDetailSig === D.runSig) return;
  lastRunDetailSig = D.runSig;
  renderPipelineSummary(); renderDiagram(); renderStepPanel(); renderRunPicker();
}

/* ---------- start ---------- */
async function start() {
  const meta = document.querySelector('meta[name="pano-token"]');
  token = meta ? meta.content : "";
  document.title = "Bant Panosu";
  try {
    const s = await api("/api/status");
    D.pipelinesOn = !!s.pipelines; D.tasksOn = !!s.tasks; D.project = s.project || ""; D.pipelinesNote = s.pipelinesNote || ""; D.readOnly = !!s.readOnly;
  } catch (err) { showMessage("error", err.message); }
  const fromUrl = new URLSearchParams(location.search).get("tab");
  const remembered = fromUrl || storeGet("tab");
  const first = availableTabs().includes(remembered) ? remembered : (D.pipelinesOn ? "pipelines" : "sessions");
  if (!D.pipelinesOn && D.pipelinesNote) $("#subtitle").title = D.pipelinesNote;
  await switchTab(first, true);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else poll().catch(() => {}).finally(schedulePoll);
});
start();
