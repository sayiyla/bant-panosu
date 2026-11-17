/* Graph: 3D network of agents and files (session) or of steps (pipeline). 3d-force-graph (MIT) is loaded on first open.
   Contract: window.PanoGraph = { open(container, { sessionId, pipeline }), close() } (plain script). */
(function () {
  "use strict";
  const { t, fmt, up } = window.PanoI18n;
  const locale = window.PanoI18n.locale;
  const LIBRARY = "/3d-force-graph.min.js";
  const FILE_LIMIT = 150;
  const cut = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; };
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rgba = (hex, a) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  };
  const usdText = (v) => { const d = v < 1 ? 3 : 2; return "$" + (v || 0).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }); };
  function el(tag, cls, text, attrs) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    if (attrs) for (const k in attrs) d.setAttribute(k, attrs[k]);
    return d;
  }

  let libraryPromise = null;
  function loadLibrary() {
    if (window.ForceGraph3D) return Promise.resolve();
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIBRARY; s.async = true;
      s.onload = () => (window.ForceGraph3D ? resolve() : reject(new Error(t("The 3D library loaded but is not defined"))));
      s.onerror = () => { libraryPromise = null; reject(new Error(t("The 3D library could not be loaded ({path})", { path: LIBRARY }))); };
      document.head.appendChild(s);
    });
    return libraryPromise;
  }
  function hasWebGL() {
    try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch (x) { return false; }
  }

  function createInstance(container, options) {
    const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const cleanups = [];
    const listen = (target, name, fn, opt) => { target.addEventListener(name, fn, opt); cleanups.push(() => target.removeEventListener(name, fn, opt)); };
    let closed = false, abort = new AbortController(), raf = 0, graph = null, ro = null;

    container.textContent = "";
    container.classList.add("gr-root");
    const C = window.PanoTheme.palette();
    const COLOR = {
      agent: C.graph.agent, written: C.write, read: rgba(C.read, 0.6), input: C.text,
      tool: C.graph.tool, toolOff: rgba(C.graph.tool, 0.3), agentOff: rgba(C.graph.agent, 0.35), dim: rgba(C.muted, 0.18), select: C.graph.select, match: C.graph.select,
    };

    /* state */
    let mode = "session"; // session | pipeline
    let hasPipelines = false, sessions = [], pipelines = [];
    let selectedSession = options.sessionId || null, selectedPipeline = options.pipeline || null;
    let data = { nodes: [], links: [] }, nodeById = new Map();
    let selected = null, hover = null, query = "", matches = new Set(), firstFit = true, loadNo = 0;

    /* ---------- DOM ---------- */
    const top = el("header", "gr-top");
    const brand = el("div", "gr-brand");
    const icon = el("div", "gr-icon");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="9" cy="18" r="2.4"/><path d="M8 7l8 1M7 8l2 8M17 10l-7 7"/></svg>';
    const titles = el("div");
    titles.appendChild(el("h2", "gr-title", up(t("Graph"))));
    const subtitle = el("p", "gr-subtitle", t("3D agent and file network"));
    titles.appendChild(subtitle);
    brand.append(icon, titles);

    const controls = el("div", "gr-controls");
    const modeGroup = el("div", "gr-mode", null, { role: "group", "aria-label": t("Graph mode") });
    const modeButton = (name, id) => { const b = el("button", "gr-btn", name, { type: "button" }); b.dataset.mode = id; listen(b, "click", () => changeMode(id)); modeGroup.appendChild(b); return b; };
    const sessionModeButton = modeButton(t("Session graph"), "session");
    const pipelineModeButton = modeButton(t("Pipeline graph"), "pipeline"); pipelineModeButton.hidden = true;
    const uid = Math.random().toString(36).slice(2, 7);
    const field = (name, id, input) => { const a = el("div", "gr-field"); a.appendChild(el("label", null, name, { for: id })); a.appendChild(input); controls.appendChild(a); return a; };
    const sessionSelect = el("select", "gr-select", null, { id: "gr-s-" + uid });
    const pipelineSelect = el("select", "gr-select", null, { id: "gr-p-" + uid });
    const sessionField = field(t("Session"), "gr-s-" + uid, sessionSelect);
    const pipelineField = field(t("Pipeline"), "gr-p-" + uid, pipelineSelect); pipelineField.hidden = true;
    const searchBox = el("input", "gr-search", null, { id: "gr-q-" + uid, type: "search", placeholder: t("agent or file name"), autocomplete: "off", spellcheck: "false" });
    field(t("Search"), "gr-q-" + uid, searchBox);
    controls.prepend(modeGroup);
    top.append(brand, controls);

    const body = el("div", "gr-body");
    const stage = el("div", "gr-stage");
    const canvasBox = el("div", "gr-canvas");
    const labelLayer = el("div", "gr-labels", null, { "aria-hidden": "true" });
    const status = el("div", "gr-status", null, { role: "status" });
    const legend = el("ul", "gr-legend");
    function buildLegend() {
      legend.textContent = "";
      const items = mode === "session"
        ? [[COLOR.agent, t("AGENT")], [COLOR.written, t("WRITTEN FILE")], [COLOR.read, t("READ ONLY")], [C.accentSoft, t("HANDOFF (THICK)")]]
        : [[COLOR.agent, t("AGENT STEP")], [COLOR.tool, t("TOOL STEP")], [COLOR.toolOff, t("STEP OFF")], [COLOR.input, t("PIPELINE INPUT")]];
      for (const [color, name] of items) { const li = el("li"); const dot = el("i"); dot.style.background = color; li.append(dot, document.createTextNode(name)); legend.appendChild(li); }
    }
    buildLegend();
    stage.append(canvasBox, labelLayer, legend, status);
    const side = el("aside", "gr-side", null, { "aria-label": t("Node details") });
    body.append(stage, side);
    container.append(top, body);

    function setStatus(text, isError) {
      status.hidden = !text;
      status.textContent = text ? (isError ? up(t("error")) + ": " : "") + text : "";
      status.classList.toggle("gr-status--error", !!isError);
    }

    /* ---------- side panel ---------- */
    function sideEmpty() {
      side.textContent = "";
      side.appendChild(el("p", "gr-label-text", t("Node details")));
      side.appendChild(el("p", "gr-empty", t("Click a node: the camera moves to it and its read/write counts and links are listed here. Drag to rotate, use the wheel to zoom.")));
      const n = data.nodes.length;
      if (n) side.appendChild(el("p", "gr-summary", t("{nodes} nodes · {links} links", { nodes: fmt.num(n), links: fmt.num(data.links.length) })));
    }
    function addRow(box, name, value) {
      const r = el("div", "gr-row"); r.append(el("span", "gr-row-name", name), el("span", "gr-row-value", String(value))); box.appendChild(r);
    }
    function sideFill(d) {
      side.textContent = "";
      side.appendChild(el("p", "gr-label-text", t("Node details")));
      const head = el("h3", "gr-node-name", d.name); head.title = d.fullName || d.name; side.appendChild(head);
      if (d.fullName && d.fullName !== d.name) side.appendChild(el("p", "gr-node-path", d.fullName));
      const rows = el("div", "gr-rows");
      for (const [a, b] of d.details || []) addRow(rows, a, b);
      side.appendChild(rows);
      const neighbors = [];
      for (const l of data.links) {
        if (l.from === d.id) neighbors.push({ id: l.to, dir: "→", l });
        else if (l.to === d.id) neighbors.push({ id: l.from, dir: "←", l });
      }
      side.appendChild(el("p", "gr-label-text gr-label-text--gap", t("Linked nodes") + " · " + neighbors.length));
      if (!neighbors.length) { side.appendChild(el("p", "gr-empty", t("No linked nodes."))); return; }
      const list = el("ul", "gr-neighbors");
      for (const k of neighbors.slice(0, 80)) {
        const n = nodeById.get(k.id); if (!n) continue;
        const li = el("li");
        const b = el("button", "gr-neighbor", null, { type: "button", title: n.fullName || n.name });
        b.append(el("span", "gr-dir", k.dir), el("span", "gr-neighbor-name", n.name), el("span", "gr-neighbor-note", (k.l.handoff ? up(t("handoff")) + " · " : "") + (k.l.note || "")));
        listen(b, "click", () => selectNode(n));
        li.appendChild(b); list.appendChild(li);
      }
      side.appendChild(list);
      if (neighbors.length > 80) side.appendChild(el("p", "gr-empty", t("Showing the first 80 links.")));
    }

    /* ---------- data: session graph ---------- */
    function sessionGraph(v) {
      const nodes = [], links = [], ids = new Set();
      const handoffs = v.handoffs || [];
      const agents = v.agents || [];
      for (const a of agents) {
        const c = a.counts || {};
        const model = a.models && a.models[0] ? a.models[0].model : "";
        nodes.push({
          id: "a:" + a.id, type: "agent", name: a.name || a.id, fullName: a.name || a.id, val: 9 + Math.sqrt(c.tools || 0) * 1.2, color: COLOR.agent,
          details: [[t("TYPE"), a.id === "main" ? t("MAIN SESSION") : t("SUBAGENT")], [t("MODEL"), model || "—"], [t("API EQUIVALENT"), usdText(a.usd || 0)], [t("TOOL CALLS"), fmt.num(c.tools)],
            [t("READS"), fmt.num(c.read)], [t("WRITES"), fmt.num(c.write)], [t("COMMANDS"), fmt.num(c.command)], [t("ERRORS"), fmt.num(c.errors)]],
          rank: (c.tools || 0) + (a.id === "main" ? 1e6 : 0),
        });
        ids.add("a:" + a.id);
      }
      const nameCount = new Map(), nameOrder = new Map();
      for (const d of nodes) nameCount.set(d.name, (nameCount.get(d.name) || 0) + 1);
      for (const d of nodes) if (nameCount.get(d.name) > 1) { const k = (nameOrder.get(d.name) || 0) + 1; nameOrder.set(d.name, k); d.name = d.name + " " + k; }
      const files = (v.fileHeat || []).slice().sort((x, y) => (y.reads + y.writes) - (x.reads + x.writes));
      const chosen = new Map();
      for (const d of files.slice(0, FILE_LIMIT)) chosen.set(d.path, d);
      for (const h of handoffs) if (!chosen.has(h.path)) { const d = files.find((x) => x.path === h.path); if (d) chosen.set(h.path, d); }
      for (const [path, d] of chosen) {
        const written = d.writes > 0;
        nodes.push({
          id: "f:" + path, type: "file", name: baseName(path), fullName: path, val: 1.2 + Math.sqrt(d.reads + d.writes) * 1.1, color: written ? COLOR.written : COLOR.read,
          details: [[t("TYPE"), written ? t("WRITTEN FILE") : t("READ-ONLY FILE")], [t("READS"), fmt.num(d.reads)], [t("WRITES"), fmt.num(d.writes)], [t("REDUNDANT READS"), fmt.num(d.redundantReads)], [t("ERRORS"), fmt.num(d.errors)], [t("AGENTS"), fmt.num((d.agents || []).length)]],
          rank: d.reads + d.writes,
        });
        ids.add("f:" + path);
      }
      const byKey = new Map();
      const addLink = (from, to, n, kind, note) => {
        if (!ids.has(from) || !ids.has(to)) return null;
        const k = from + ">" + to; let l = byKey.get(k);
        if (!l) { l = { source: from, target: to, from, to, n: 0, kind, handoff: false, note: "" }; byKey.set(k, l); links.push(l); }
        l.n += n; if (note) l.note = note; return l;
      };
      for (const a of agents) {
        if (a.parent) addLink("a:" + a.parent, "a:" + a.id, 1, "parent", t("subagent"));
        for (const d of a.files || []) {
          if (!chosen.has(d.path)) continue;
          if (d.writes > 0) addLink("a:" + a.id, "f:" + d.path, d.writes, "write", t("{n} writes", { n: d.writes }));
          if (d.reads > 0) addLink("f:" + d.path, "a:" + a.id, d.reads, "read", t("{n} reads", { n: d.reads }));
        }
      }
      for (const h of handoffs) {
        const l1 = addLink("a:" + h.writer, "f:" + h.path, 1, "write", ""), l2 = addLink("f:" + h.path, "a:" + h.reader, 1, "read", "");
        if (l1) l1.handoff = true; if (l2) l2.handoff = true;
      }
      const connected = new Set(); for (const l of links) { connected.add(l.from); connected.add(l.to); }
      for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].type === "file" && !connected.has(nodes[k].id)) { ids.delete(nodes[k].id); nodes.splice(k, 1); }
      let mx = 1; for (const l of links) mx = Math.max(mx, l.n);
      for (const l of links) {
        l.particles = l.handoff ? 6 : l.kind === "parent" ? 1 : clamp(1 + Math.floor(Math.log2(l.n + 1) * 0.8), 1, 4);
        l.speed = l.handoff ? 0.012 : 0.006 + 0.004 * (l.n / mx);
        l.width = l.handoff ? 2.6 : 0;
      }
      return { nodes, links, summary: t("{agents} agents · {files} files", { agents: agents.length, files: nodes.filter((d) => d.type === "file").length }) + (files.length > chosen.size ? " " + t("(of {n})", { n: fmt.num(files.length) }) : "") + " · " + t("{n} handoffs", { n: handoffs.length }) };
    }

    /* ---------- data: pipeline graph ---------- */
    function pipelineGraph(p) {
      const nodes = [], links = [], ids = new Set();
      let hasInput = false;
      for (const k of p.edges || []) if (k.source === "input") hasInput = true;
      if (hasInput) { nodes.push({ id: "s:input", type: "input", name: t("input"), fullName: t("external input of the pipeline"), val: 5, color: COLOR.input, details: [[t("TYPE"), t("PIPELINE INPUT")]], rank: 1e6 }); ids.add("s:input"); }
      for (const a of p.steps || []) {
        const agent = a.kind === "agent", on = a.enabled !== false;
        const model = a.model && a.model.chain ? a.model.chain.join(" → ") : "—";
        nodes.push({
          id: "s:" + a.id, type: agent ? "agent" : "tool", name: a.id, fullName: a.id, val: agent ? 8 : 4, color: agent ? (on ? COLOR.agent : COLOR.agentOff) : (on ? COLOR.tool : COLOR.toolOff),
          details: [[t("TYPE"), agent ? t("AGENT STEP") : t("TOOL STEP")], [t("ORDER"), a.order], [t("EXECUTOR"), a.executor || "—"], [t("STATE"), on ? t("ON") : t("OFF")], [t("OPTIONAL"), a.optional ? t("YES") : t("NO")], [t("MODEL"), model]],
          rank: 1000 - (a.order || 0), off: !on,
        });
        ids.add("s:" + a.id);
      }
      for (const k of p.edges || []) {
        const from = "s:" + k.source, to = "s:" + k.target;
        if (!ids.has(from) || !ids.has(to)) continue;
        links.push({ source: from, target: to, from, to, n: 1, kind: "pipeline", handoff: false, label: k.label || "", note: k.label || "", optional: !!k.optional, particles: k.optional ? 1 : 2, speed: 0.007, width: 0 });
      }
      return { nodes, links, summary: t("{steps} steps · {edges} edges", { steps: (p.steps || []).length, edges: links.length }) };
    }

    /* ---------- graph ---------- */
    function nodeColor(d) {
      if (selected && d.id === selected.id) return COLOR.select;
      if (query) return matches.has(d.id) ? COLOR.match : COLOR.dim;
      return d.color;
    }
    function touchesSelected(l) { return selected && (l.from === selected.id || l.to === selected.id); }
    function linkColor(l) {
      if (query) return rgba(C.line2, 0.4);
      if (l.handoff) return C.accentSoft;
      if (selected) return touchesSelected(l) ? rgba(C.accentSoft, 0.9) : rgba(C.line2, 0.35);
      if (l.kind === "parent") return rgba(C.accent, 0.5);
      if (l.optional) return rgba(C.sand, 0.35);
      return l.kind === "write" ? rgba(C.amber, 0.5) : rgba(C.sand, 0.4);
    }
    function tooltip(d) {
      const head = "<b>" + esc(d.name) + "</b>";
      const sub = d.fullName && d.fullName !== d.name ? "<br>" + esc(cut(d.fullName, 90)) : "";
      const more = d.details ? "<br>" + d.details.slice(0, 3).map(([a, b]) => esc(a) + ": " + esc(b)).join(" · ") : "";
      return head + sub + more;
    }
    function linkTooltip(l) {
      return esc((nodeById.get(l.from) || {}).name || "") + " → " + esc((nodeById.get(l.to) || {}).name || "") + (l.note ? "<br>" + esc(l.note) : "") + (l.handoff ? "<br>" + esc(up(t("handoff"))) : "");
    }
    function buildGraph() {
      const w = Math.max(200, stage.clientWidth), h = Math.max(200, stage.clientHeight);
      const g = window.ForceGraph3D()(canvasBox)
        .width(w).height(h).backgroundColor(C.bg).showNavInfo(false)
        .nodeRelSize(4).nodeResolution(10).nodeOpacity(0.95)
        .nodeVal((d) => d.val).nodeColor(nodeColor).nodeLabel(tooltip)
        .linkColor(linkColor).linkOpacity(0.7).linkWidth((l) => (selected && touchesSelected(l) && !l.handoff ? 1.2 : l.width))
        .linkLabel(linkTooltip)
        .linkDirectionalParticles((l) => (reducedMotion ? 0 : l.particles))
        .linkDirectionalParticleSpeed((l) => l.speed)
        .linkDirectionalParticleWidth((l) => (l.handoff ? 3.4 : 1.7))
        .linkDirectionalParticleColor((l) => (l.handoff ? C.graph.spark : l.kind === "write" ? C.amber : l.kind === "parent" ? C.accentSoft : C.sand))
        .linkDirectionalArrowLength((l) => (reducedMotion || l.handoff ? 5 : 0)).linkDirectionalArrowRelPos(0.92)
        .linkDirectionalArrowColor(() => C.accentSoft)
        .onNodeClick((d) => selectNode(d))
        .onNodeHover((d) => { hover = d || null; canvasBox.style.cursor = d ? "pointer" : ""; })
        .onBackgroundClick(() => selectNode(null))
        .onEngineStop(() => { if (firstFit && !closed) { firstFit = false; try { g.zoomToFit(700, 70); } catch (x) { /* ignore */ } } })
        .cooldownTime(7000).d3VelocityDecay(0.32);
      try { const c = g.d3Force("charge"); if (c && c.strength) c.strength(-70); const l = g.d3Force("link"); if (l && l.distance) l.distance(34);
        g.d3Force("gravity", (alpha) => { for (const n of data.nodes) { if (n.x == null) continue; n.vx -= n.x * 0.05 * alpha; n.vy -= n.y * 0.05 * alpha; n.vz -= n.z * 0.05 * alpha; } }); } catch (x) { /* ignore */ }
      return g;
    }
    function refreshColors() {
      if (!graph) return;
      graph.nodeColor(nodeColor).linkColor(linkColor).linkWidth((l) => (selected && touchesSelected(l) && !l.handoff ? 1.2 : l.width));
    }
    function selectNode(d) {
      selected = d || null;
      if (!d) { sideEmpty(); refreshColors(); return; }
      sideFill(d);
      refreshColors();
      moveCamera(d);
    }
    function moveCamera(d) {
      if (!graph || d.x == null) return;
      const dist = 90 + 7 * Math.cbrt(d.val || 1) * 4 / 2, ratio = 1 + dist / (Math.hypot(d.x, d.y, d.z) || 1);
      graph.cameraPosition({ x: d.x * ratio, y: d.y * ratio, z: d.z * ratio }, { x: d.x, y: d.y, z: d.z }, reducedMotion ? 0 : 1100);
    }
    function applyData(next) {
      data = next;
      nodeById = new Map(data.nodes.map((d) => [d.id, d]));
      selected = null; hover = null; firstFit = true;
      applySearch(false);
      subtitle.textContent = (mode === "session" ? t("session graph") : t("pipeline graph")) + " · " + (next.summary || "");
      sideEmpty();
      if (graph) {
        graph.graphData({ nodes: data.nodes, links: data.links });
        for (const ms of [1500, 4000]) setTimeout(() => { if (!closed && graph && !selected && firstFit) { try { graph.zoomToFit(600, 60); } catch (x) { /* ignore */ } } }, ms);
      }
      buildLabels();
    }

    /* ---------- search ---------- */
    function applySearch(refresh) {
      const q = query.trim().toLocaleLowerCase(locale);
      matches = new Set();
      if (q) for (const d of data.nodes) if ((d.name + " " + (d.fullName || "")).toLocaleLowerCase(locale).includes(q)) matches.add(d.id);
      if (refresh !== false) refreshColors();
      if (q) setStatus(matches.size ? t("{n} matches (Enter: go to the first)", { n: matches.size }) : t("No matching node"));
      else setStatus("");
    }
    listen(searchBox, "input", () => { query = searchBox.value; applySearch(); });
    listen(searchBox, "keydown", (ev) => {
      if (ev.key === "Enter" && matches.size) { const first = data.nodes.find((d) => matches.has(d.id)); if (first) selectNode(first); }
    });

    /* ---------- label layer (agent names stay visible) ---------- */
    let permanent = [];
    function buildLabels() {
      labelLayer.textContent = ""; permanent = [];
      const agents = data.nodes.filter((d) => d.type === "agent").sort((a, b) => b.rank - a.rank).slice(0, 8);
      for (const d of agents) addPermanentLabel(d);
    }
    function addPermanentLabel(d) {
      const node = el("div", "gr-label", up(cut(d.name, 20)));
      node.style.display = "none";
      labelLayer.appendChild(node);
      permanent.push({ d, node });
    }
    const temporary = new Map();
    function temporaryLabel(d) {
      let node = temporary.get(d.id);
      if (!node) { node = el("div", "gr-label gr-label--hot", up(cut(d.name, 22))); labelLayer.appendChild(node); temporary.set(d.id, node); }
      return node;
    }
    function placeLabels() {
      if (!graph) return;
      const cam = graph.camera(), w = stage.clientWidth, h = stage.clientHeight;
      let dir = null;
      try { dir = cam.getWorldDirection(new cam.position.constructor()); } catch (x) { dir = null; }
      const shown = new Set(permanent.map((p) => p.d.id));
      const extra = [];
      if (selected) extra.push(selected);
      if (hover) extra.push(hover);
      let counter = 0;
      for (const id of matches) { if (counter++ > 10) break; const d = nodeById.get(id); if (d) extra.push(d); }
      const use = permanent.map((p) => ({ d: p.d, node: p.node }));
      for (const d of extra) if (!shown.has(d.id)) { shown.add(d.id); use.push({ d, node: temporaryLabel(d) }); }
      for (const u of use) {
        const d = u.d;
        if (d.x == null || !dir) { u.node.style.display = "none"; continue; }
        const dx = d.x - cam.position.x, dy = d.y - cam.position.y, dz = d.z - cam.position.z;
        if (dx * dir.x + dy * dir.y + dz * dir.z <= 0) { u.node.style.display = "none"; continue; }
        const p = graph.graph2ScreenCoords(d.x, d.y, d.z);
        if (p.x < -40 || p.y < -20 || p.x > w + 40 || p.y > h + 20) { u.node.style.display = "none"; continue; }
        u.node.style.display = "";
        u.node.style.transform = "translate(" + Math.round(p.x) + "px," + Math.round(p.y) + "px) translate(-50%, 12px)";
        const hot = (selected && selected.id === d.id) || (hover && hover.id === d.id) || matches.has(d.id);
        u.node.classList.toggle("gr-label--hot", !!hot);
      }
      for (const [, node] of temporary) if (!use.some((u) => u.node === node)) node.style.display = "none";
    }
    function loop() {
      raf = 0;
      if (closed) return;
      if (!document.hidden) placeLabels();
      raf = requestAnimationFrame(loop);
    }
    listen(document, "visibilitychange", () => {
      if (!graph) return;
      if (document.hidden) graph.pauseAnimation(); else graph.resumeAnimation();
    });

    /* ---------- fetching ---------- */
    async function fetchJson(route) {
      const r = await fetch(route, { signal: abort.signal });
      if (!r.ok) throw new Error(t("{route} answered {status}", { route: route.split("?")[0], status: r.status }));
      return r.json();
    }
    function fillSelect(select, list, label, value) {
      select.textContent = "";
      for (const o of list) { const op = el("option", null, label(o)); op.value = value(o); select.appendChild(op); }
    }
    async function loadData() {
      const no = ++loadNo;
      setStatus(mode === "session" ? t("Loading session… (large sessions can take a few seconds)") : t("Loading pipeline…"));
      try {
        let next;
        if (mode === "session") {
          if (!selectedSession) { setStatus(t("No session to show"), true); applyData({ nodes: [], links: [], summary: "" }); return; }
          const v = await fetchJson("/api/session?id=" + encodeURIComponent(selectedSession));
          if (closed || no !== loadNo) return;
          next = sessionGraph(v);
        } else {
          if (!selectedPipeline) { setStatus(t("No pipeline to show"), true); return; }
          const p = await fetchJson("/api/pipeline?name=" + encodeURIComponent(selectedPipeline));
          if (closed || no !== loadNo) return;
          next = pipelineGraph(p);
        }
        applyData(next);
        if (!next.nodes.length) setStatus(t("Nothing to show in this record"));
      } catch (err) {
        if (closed || (err && err.name === "AbortError") || no !== loadNo) return;
        setStatus(err && err.message ? err.message : t("unknown error"), true);
      }
    }
    function changeMode(next) {
      if (next === "pipeline" && !hasPipelines) return;
      mode = next; buildLegend();
      query = ""; searchBox.value = ""; matches = new Set();
      sessionModeButton.setAttribute("aria-pressed", String(mode === "session"));
      pipelineModeButton.setAttribute("aria-pressed", String(mode === "pipeline"));
      sessionField.hidden = mode !== "session"; pipelineField.hidden = mode !== "pipeline";
      loadData();
    }
    listen(sessionSelect, "change", () => { selectedSession = sessionSelect.value; loadData(); });
    listen(pipelineSelect, "change", () => { selectedPipeline = pipelineSelect.value; loadData(); });

    async function start() {
      sideEmpty();
      sessionModeButton.setAttribute("aria-pressed", "true"); pipelineModeButton.setAttribute("aria-pressed", "false");
      sessionField.hidden = false; pipelineField.hidden = true;
      if (!hasWebGL()) { setStatus(t("WebGL is not available in this browser, so the 3D graph cannot be drawn. Enable hardware acceleration or try another browser."), true); return; }
      setStatus(t("Loading 3D library…"));
      try { await loadLibrary(); } catch (err) { if (!closed) setStatus(err.message, true); return; }
      if (closed) return;
      try { graph = buildGraph(); } catch (err) { setStatus(t("The 3D graph could not be started: {error}", { error: err && err.message ? err.message : err }), true); return; }
      ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (graph && !closed) graph.width(Math.max(200, stage.clientWidth)).height(Math.max(200, stage.clientHeight)); }) : null;
      if (ro) ro.observe(stage);
      try {
        const [status0, sl, pl] = await Promise.all([
          fetchJson("/api/status").catch(() => ({})),
          fetchJson("/api/sessions").catch(() => ({ sessions: [] })),
          fetchJson("/api/pipelines").catch(() => ({ pipelines: [] })),
        ]);
        if (closed) return;
        hasPipelines = !!status0.pipelines;
        sessions = sl.sessions || []; pipelines = pl.pipelines || [];
        if (!selectedSession || !sessions.some((o) => o.id === selectedSession)) selectedSession = sessions[0] ? sessions[0].id : null;
        fillSelect(sessionSelect, sessions, (o) => cut(o.title || o.id, 44) + " · " + (o.startedAt ? new Date(o.startedAt).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "") + (o.live ? " · " + t("live") : ""), (o) => o.id);
        if (selectedSession) sessionSelect.value = selectedSession;
        fillSelect(pipelineSelect, pipelines, (p) => p.name, (p) => p.name);
        if (!selectedPipeline || !pipelines.some((p) => p.name === selectedPipeline)) selectedPipeline = pipelines[0] ? pipelines[0].name : null;
        if (selectedPipeline) pipelineSelect.value = selectedPipeline;
        pipelineModeButton.hidden = !(hasPipelines && pipelines.length);
        await loadData();
        if (!closed) raf = requestAnimationFrame(loop);
      } catch (err) {
        if (!closed && !(err && err.name === "AbortError")) setStatus(err && err.message ? err.message : t("unknown error"), true);
      }
    }
    start();

    return {
      close() {
        closed = true;
        if (raf) cancelAnimationFrame(raf); raf = 0;
        abort.abort();
        if (ro) ro.disconnect();
        cleanups.forEach((f) => f());
        if (graph) {
          try { graph.pauseAnimation(); } catch (x) { /* ignore */ }
          try { graph._destructor(); } catch (x) { /* ignore */ }
          graph = null;
        }
        container.textContent = "";
        container.classList.remove("gr-root");
        data = { nodes: [], links: [] }; nodeById.clear();
      },
    };
  }

  let active = null;
  window.PanoGraph = {
    open(container, options) { if (active) active.close(); active = createInstance(container, options || {}); },
    close() { if (active) { active.close(); active = null; } },
  };
})();
