/* Command: replays one session from start to end as a HUD.
   Contract: window.PanoCommand = { open(container, { sessionId }), close() } (plain script, no libraries). */
(function () {
  "use strict";
  const { t, fmt, up } = window.PanoI18n;
  const locale = window.PanoI18n.locale;

  /* ---------- small helpers ---------- */
  const GAP_LIMIT = 60000; // the gap between two consecutive events counts for at most this much (active time)
  const SPEEDS = [[30, "30 s"], [45, "45 s"], [120, "2 min"], [300, "5 min"]];
  const GROUP = { read: 0, search: 0, web: 0, agent: 1, skill: 1, write: 2, command: 2 };
  const GROUP_NAMES = () => [t("context"), t("decision"), t("action")];
  const STATE_WORD = () => ({ read: t("reading"), write: t("writing"), command: t("command"), web: t("web"), search: t("search"), agent: t("subagent"), skill: t("skill"), other: t("tool") });
  const KIND_NAME = () => ({ read: t("read"), write: t("write"), command: t("command"), web: t("web"), search: t("search"), agent: t("subagent"), skill: t("skill"), other: t("tool") });
  const INWARD = { read: 1, search: 1, web: 1 }; // the beam flows inward for these kinds; the others flow outward

  const usdText = (v) => { const d = v < 1 ? 3 : 2; return "$" + (v || 0).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }); };
  const two = (n) => String(n).padStart(2, "0");
  const clockText = (ms) => {
    const s = Math.floor(Math.max(0, ms) / 1000), sec = s % 60, min = Math.floor(s / 60) % 60, h = Math.floor(s / 3600);
    return h ? h + ":" + two(min) + ":" + two(sec) : two(min) + ":" + two(sec);
  };
  const cut = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; };
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lastAtOrBelow = (arr, x, n) => { // last index with arr[i] <= x, or -1
    let lo = 0, hi = n - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  };
  const rgba = (hex, a) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  };
  const seeded = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };

  function commandName(s) {
    s = String(s || "").trim();
    let before;
    do { // leading "cd ... &&" and VAR="..." prefixes are dropped
      before = s;
      s = s.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "").replace(/^[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s*(&&|;)?\s*/, "");
    } while (s !== before && s);
    return s || "command";
  }
  function shortLabel(ev) {
    if (ev.path) return baseName(ev.path);
    if (ev.kind === "command") return (commandName(ev.summary).split(/\s+/)[0] || "command").replace(/^["']|["']$/g, "").slice(0, 18);
    if (ev.kind === "agent" || ev.kind === "skill") return String(ev.summary || ev.tool || "").split(":")[0].trim().slice(0, 18);
    return String(ev.summary || ev.tool || "").slice(0, 16);
  }
  function targetText(ev) {
    if (ev.path) return baseName(ev.path);
    if (ev.kind === "command") return cut(commandName(ev.summary).split(/\s+/).slice(0, 3).join(" "), 40);
    if (ev.kind === "agent") return cut(String(ev.summary || "").split(":")[0].trim() || ev.tool, 40);
    return cut(ev.summary || ev.tool || "", 44);
  }

  function el(tag, cls, text, attrs) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    if (attrs) for (const k in attrs) d.setAttribute(k, attrs[k]);
    return d;
  }
  function setText(d, s) { s = String(s); if (d._s !== s) { d._s = s; d.textContent = s; } }

  const PULSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h4l2.5-6 4 12 2.5-6H22"/></svg>';

  /* ---------- one instance ---------- */
  function createInstance(container, options) {
    const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const cleanups = [];
    const listen = (target, name, fn, opt) => { target.addEventListener(name, fn, opt); cleanups.push(() => target.removeEventListener(name, fn, opt)); };
    let closed = false, raf = 0, abort = null, poller = 0, loadNo = 0;

    container.textContent = "";
    container.classList.add("cmd-root");
    const C = window.PanoTheme.palette();

    /* state */
    let V = null; // derived data of the loaded session
    let sessions = [], selectedId = null;
    let pos = 0, playing = false, following = false, speedSec = 45, lastFrame = 0;
    let lastIdx = -2, lastSpend = -2, lastPos = -1, lastPrompt = -2, force = true;
    let target = null; // { key, name, dir, error }
    const SY = { idx: -1, sIdx: -1, files: new Map(), models: new Map() };

    /* ---------- DOM ---------- */
    const D = {};
    const top = el("header", "cmd-top");
    const brand = el("div", "cmd-brand");
    const icon = el("div", "cmd-icon"); icon.innerHTML = PULSE_SVG; // fixed, safe icon
    const titles = el("div");
    titles.appendChild(el("h2", "cmd-title", up(t("Command"))));
    D.subtitle = el("p", "cmd-subtitle", t("session replay"));
    titles.appendChild(D.subtitle);
    brand.append(icon, titles);
    const topRight = el("div", "cmd-top-right");
    const pickField = el("div", "cmd-field");
    const pickId = "cmd-pick-" + Math.random().toString(36).slice(2, 7);
    pickField.appendChild(el("label", null, t("Session"), { for: pickId }));
    D.sessionSelect = el("select", "cmd-select", null, { id: pickId });
    pickField.appendChild(D.sessionSelect);
    D.live = el("span", "cmd-live", up(t("live"))); D.live.hidden = true;
    topRight.append(pickField, D.live);
    top.append(brand, topRight);

    const numbers = el("div", "cmd-numbers");
    const numberBox = (label, key) => {
      const k = el("div", "cmd-number");
      k.appendChild(el("p", "cmd-label", label));
      D[key] = el("div", "cmd-number-value", "—");
      D[key + "Sub"] = el("div", "cmd-number-sub", "");
      k.append(D[key], D[key + "Sub"]);
      return k;
    };
    numbers.append(numberBox(t("API equivalent / USD"), "usd"), numberBox(t("Output tokens"), "tok"), numberBox(t("Session clock"), "clock"));
    D.usdSub.textContent = t("subscription is not billed");

    const controls = el("div", "cmd-controls", null, { role: "group", "aria-label": t("Playback controls") });
    const button = (text, label, onclick, extra) => {
      const b = el("button", "cmd-btn" + (extra ? " " + extra : ""), text, { type: "button" });
      if (label) b.setAttribute("aria-label", label);
      listen(b, "click", onclick); return b;
    };
    D.toStart = button(t("Back to start"), t("Back to start"), () => { following = false; setPosition(0); });
    D.prevPrompt = button("◀ " + t("Prompt"), t("Previous prompt"), () => goToPrompt(-1));
    D.play = button(t("Play"), t("Play or pause"), () => togglePlay(), "cmd-btn-main");
    D.nextPrompt = button(t("Prompt") + " ▶", t("Next prompt"), () => goToPrompt(1));
    D.slider = el("input", "cmd-slider", null, { type: "range", min: "0", max: "10000", step: "1", value: "0", "aria-label": t("Playback position") });
    listen(D.slider, "input", () => { following = false; setPosition((+D.slider.value / 10000) * totalMs()); });
    const speedField = el("div", "cmd-field");
    const speedId = pickId + "-speed";
    speedField.appendChild(el("label", null, t("Length"), { for: speedId }));
    D.speed = el("select", "cmd-select", null, { id: speedId, "aria-label": t("Total playback length") });
    for (const [sec, name] of SPEEDS) { const o = el("option", null, name); o.value = String(sec); if (sec === speedSec) o.selected = true; D.speed.appendChild(o); }
    listen(D.speed, "change", () => { speedSec = +D.speed.value || 45; });
    speedField.appendChild(D.speed);
    D.goLive = button(t("Follow live"), t("Follow live"), () => followLive());
    D.goLive.setAttribute("aria-pressed", "false"); D.goLive.hidden = true;
    controls.append(D.toStart, D.prevPrompt, D.play, D.nextPrompt, D.slider, speedField, D.goLive);

    /* decision matrix */
    const matrix = el("div", "cmd-panel cmd-matrix");
    matrix.appendChild(el("p", "cmd-label", t("Decision line / active loops")));
    D.cells = [];
    const groupNames = GROUP_NAMES();
    for (let g = 0; g < 3; g++) {
      const row = el("div", "cmd-matrix-row");
      row.appendChild(el("div", "cmd-matrix-name", up(groupNames[g])));
      const cells = [];
      for (let k = 0; k < 6; k++) { const c = el("div", "cmd-cell", ""); row.appendChild(c); cells.push(c); }
      D.cells.push(cells); matrix.appendChild(row);
    }

    /* middle: prompts, sphere, side column */
    const middle = el("div", "cmd-middle");
    const prompts = el("aside", "cmd-panel cmd-prompts", null, { "aria-label": t("User prompts") });
    D.promptTitle = el("p", "cmd-label", t("Session / prompts"));
    D.promptList = el("ul", "cmd-prompt-list");
    prompts.append(D.promptTitle, D.promptList);

    const stage = el("section", "cmd-stage", null, { "aria-label": t("Event stage") });
    const canvasBox = el("div", "cmd-canvas-box");
    D.sphere = el("canvas", null, null, { role: "img", "aria-label": t("Particle sphere with agent and file labels around it") });
    canvasBox.appendChild(D.sphere);
    D.card = el("div", "cmd-card", null, { role: "status", "aria-live": "off" });
    const cardTop = el("div", "cmd-card-top");
    D.cardError = el("span", "cmd-err-tag", t("ERROR")); D.cardError.hidden = true;
    D.cardTop = el("span", null, "");
    cardTop.append(D.cardError, D.cardTop);
    D.cardBig = el("div", "cmd-card-big", "");
    D.cardSub = el("div", "cmd-card-sub", "");
    D.card.append(cardTop, D.cardBig, D.cardSub);
    stage.append(canvasBox, D.card);

    const side = el("aside", "cmd-side");
    const panel = (name) => { const p = el("div", "cmd-panel"); p.appendChild(el("p", "cmd-label", name)); side.appendChild(p); return p; };
    const pScan = panel(t("Activity scan"));
    D.scan = el("canvas", null, null, { role: "img", "aria-label": t("Density of the last 60 events over time") });
    D.scanSub = el("div", "cmd-small", "");
    pScan.append(D.scan, D.scanSub);
    const pFiles = panel(t("Most active files"));
    D.files = el("div"); pFiles.appendChild(D.files);
    const pGauges = panel(t("Health"));
    D.gauges = el("div"); pGauges.appendChild(D.gauges);
    const pState = panel(t("Agent state"));
    D.state = el("p", "cmd-state-word", up(t("waiting")));
    D.stateModel = el("div", "cmd-small", "");
    pState.append(D.state, D.stateModel);
    const pLog = panel(t("Event log"));
    D.log = el("ul", "cmd-log"); pLog.appendChild(D.log);
    middle.append(prompts, stage, side);

    /* bottom band */
    const bottom = el("div", "cmd-bottom");
    const pCost = el("div", "cmd-panel cmd-cost");
    const costHead = el("div", "cmd-head-row");
    costHead.appendChild(el("p", "cmd-label", t("Cost history / USD")));
    D.costRange = el("span", "cmd-small", "");
    costHead.appendChild(D.costRange);
    D.cost = el("canvas", null, null, { role: "img", "aria-label": t("Cumulative cost over time, line chart") });
    pCost.append(costHead, D.cost);
    const bottom3 = el("div", "cmd-bottom3");
    const pNet = el("div", "cmd-panel"); pNet.appendChild(el("p", "cmd-label", t("Agent network")));
    D.net = el("canvas", null, null, { role: "img", "aria-label": t("Relationship network between agents") });
    D.netSub = el("div", "cmd-small", "");
    pNet.append(D.net, D.netSub);
    const pModels = el("div", "cmd-panel"); pModels.appendChild(el("p", "cmd-label", t("Model split")));
    D.models = el("div", "cmd-models"); pModels.appendChild(D.models);
    const pDensity = el("div", "cmd-panel"); pDensity.appendChild(el("p", "cmd-label", t("Event density")));
    D.density = el("canvas", null, null, { role: "img", "aria-label": t("Histogram of events over time; slices with errors are highlighted") });
    pDensity.appendChild(D.density);
    bottom3.append(pNet, pModels, pDensity);
    bottom.append(pCost, bottom3);

    /* loading layer */
    D.loading = el("div", "cmd-loading", null, { role: "status" });
    D.spinner = el("div", "cmd-spinner");
    D.loadingText = el("div", "cmd-loading-text", up(t("loading session…")));
    D.retry = el("button", "cmd-btn", t("Retry"), { type: "button" }); D.retry.hidden = true;
    D.loading.append(D.spinner, D.loadingText, D.retry);

    const body = el("div", "cmd-body");
    body.append(numbers, controls, matrix, middle, bottom, D.loading);
    container.append(top, body);

    function showLoading(text, isError) {
      D.loading.hidden = false;
      D.spinner.hidden = !!isError;
      D.retry.hidden = !isError;
      D.loadingText.textContent = text;
    }
    const totalMs = () => (V && V.total > 0 ? V.total : 1);

    /* ---------- canvases (size cache) ---------- */
    const CV = {};
    const setupCanvas = (name, c) => { CV[name] = { c, x: c.getContext("2d"), w: 10, h: 10, dpr: 1 }; };
    setupCanvas("sphere", D.sphere); setupCanvas("scan", D.scan); setupCanvas("cost", D.cost);
    setupCanvas("net", D.net); setupCanvas("density", D.density);
    const costBase = document.createElement("canvas"), costLit = document.createElement("canvas");
    let costReady = false;
    function measureAll() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const name in CV) {
        const v = CV[name];
        const w = Math.max(10, Math.round(v.c.clientWidth)), h = Math.max(10, Math.round(v.c.clientHeight));
        const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
        if (v.c.width !== pw || v.c.height !== ph) { v.c.width = pw; v.c.height = ph; }
        v.w = w; v.h = h; v.dpr = dpr;
      }
      costReady = false; force = true;
      computeSlots();
    }
    function clearCanvas(v) { v.x.setTransform(v.dpr, 0, 0, v.dpr, 0, 0); v.x.clearRect(0, 0, v.w, v.h); return v.x; }
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (!closed) measureAll(); }) : null;
    if (ro) { ro.observe(container); ro.observe(D.sphere); } else listen(window, "resize", measureAll);

    /* ---------- data ---------- */
    async function fetchSessions() {
      const r = await fetch("/api/sessions", { signal: abort.signal });
      if (!r.ok) throw new Error(t("Could not get the session list ({status})", { status: r.status }));
      const v = await r.json();
      return Array.isArray(v.sessions) ? v.sessions : [];
    }
    function fillSelect() {
      D.sessionSelect.textContent = "";
      for (const o of sessions) {
        const when = o.startedAt ? new Date(o.startedAt).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
        const opt = el("option", null, cut(o.title || o.id, 46) + " · " + when + (o.live ? " · " + t("live") : ""));
        opt.value = o.id; if (o.id === selectedId) opt.selected = true;
        D.sessionSelect.appendChild(opt);
      }
      if (!sessions.length) D.sessionSelect.appendChild(el("option", null, t("no sessions")));
    }
    listen(D.sessionSelect, "change", () => { if (D.sessionSelect.value) loadSession(D.sessionSelect.value); });
    listen(D.retry, "click", () => start());

    async function loadSession(id, quiet) {
      const no = ++loadNo;
      if (!quiet) { selectedId = id; following = false; playing = false; showLoading(up(t("loading session…")) + " (" + t("large sessions can take a few seconds") + ")"); }
      try {
        const r = await fetch("/api/session?id=" + encodeURIComponent(id), { signal: abort.signal });
        if (!r.ok) throw new Error(t("Could not get the session ({status})", { status: r.status }));
        const v = await r.json();
        if (closed || no !== loadNo) return;
        buildData(v, !!quiet);
        if (V && V.n) D.loading.hidden = true;
      } catch (err) {
        if (closed || (err && err.name === "AbortError") || no !== loadNo) return;
        if (!quiet) showLoading(up(t("error")) + ": " + (err && err.message ? err.message : t("unknown error")), true);
      }
    }

    function activeTime(ms) {
      const j = lastAtOrBelow(V.T, ms, V.n);
      return j < 0 ? 0 : V.TA[j] + Math.min(GAP_LIMIT, ms - V.T[j]);
    }

    function buildData(v, quiet) {
      const rp = v.replay || {};
      const ev = Array.isArray(rp.events) ? rp.events : [];
      const n = ev.length;
      const T = new Float64Array(n), TA = new Float64Array(n);
      for (let i = 0; i < n; i++) { T[i] = ev[i].t; TA[i] = i ? TA[i - 1] + Math.min(GAP_LIMIT, Math.max(0, T[i] - T[i - 1])) : 0; }
      const total = n ? TA[n - 1] : 0;
      const startMs = Date.parse(v.startedAt) || 0;
      const previous = V;
      V = { v, ev, n, T, TA, total, startMs, live: !!v.live };
      const agents = (v.agents || []).map((a) => Object.assign({}, a, { firstMs: (Date.parse(a.first) || startMs) - startMs }));
      V.agents = agents;
      V.agentById = new Map(agents.map((a) => [a.id, a]));
      V.multiDay = new Date(startMs).toDateString() !== new Date(startMs + (v.durationMs || 0)).toDateString();

      /* spend: placed on active time, cumulative arrays */
      const sp = Array.isArray(rp.spend) ? rp.spend : [];
      const ns = sp.length;
      const ST = new Float64Array(ns), SU = new Float64Array(ns), SC = new Float64Array(ns);
      let sumUsd = 0, sumOut = 0;
      V.agentModel = new Map();
      for (let k = 0; k < ns; k++) {
        const h = sp[k];
        sumUsd += h[3] || 0; sumOut += h[4] || 0;
        ST[k] = n ? activeTime(h[0]) : 0; SU[k] = sumUsd; SC[k] = sumOut;
        let m = V.agentModel.get(h[1]); if (!m) { m = { t: [], m: [] }; V.agentModel.set(h[1], m); }
        m.t.push(h[0]); m.m.push(h[2]);
      }
      V.sp = sp; V.ns = ns; V.ST = ST; V.SU = SU; V.SC = SC; V.usdTotal = sumUsd; V.outTotal = sumOut;
      V.modelTotals = new Map();
      for (const h of sp) { const m = V.modelTotals.get(h[2]) || { usd: 0, out: 0 }; m.usd += h[3] || 0; m.out += h[4] || 0; V.modelTotals.set(h[2], m); }

      /* prompts */
      V.prompts = (Array.isArray(rp.prompts) ? rp.prompts : []).map((s) => ({ t: s.t, time: s.time, text: String(s.text || ""), ta: n ? activeTime(s.t) : 0 }));
      V.promptTA = Float64Array.from(V.prompts.map((s) => s.ta));

      /* density slices */
      const NB = 60; V.NB = NB;
      V.sliceCount = new Uint32Array(NB); V.sliceErrors = new Uint32Array(NB);
      for (let i = 0; i < n; i++) {
        const b = total > 0 ? Math.min(NB - 1, Math.floor((TA[i] / total) * NB)) : 0;
        V.sliceCount[b]++; if (ev[i].error) V.sliceErrors[b]++;
      }
      V.sliceMax = Math.max(1, ...V.sliceCount);

      buildLabels();
      buildNetwork();
      buildGauges();
      buildModelPanel();
      buildPromptList();

      D.subtitle.textContent = t("session replay") + " · " + (v.title || v.id) + (rp.truncated ? " · " + t("thinned sample ({shown} of {total} events)", { shown: fmt.num(n), total: fmt.num(rp.truncated) }) : "");
      D.live.hidden = !v.live;
      D.goLive.hidden = !v.live;
      D.costRange.textContent = "$0 → " + usdText(sumUsd || (v.totals && v.totals.usd) || 0) + " · " + (v.startedAt ? new Date(v.startedAt).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "");
      fillSelect();

      if (quiet && previous) { pos = following ? total : Math.min(pos, total); }
      else {
        pos = 0; following = false;
        playing = !reducedMotion && n > 1;
      }
      SY.idx = -1; SY.sIdx = -1; SY.files.clear(); SY.models.clear();
      lastIdx = -2; lastSpend = -2; lastPos = -1; lastPrompt = -2; force = true; costReady = false;
      target = null;
      if (!n) { showLoading(t("There are no events to replay in this session."), false); D.spinner.hidden = true; }
      measureAll();
      updatePlayButton();
      setupPolling();
      startLoop();
    }

    /* ---------- labels around the sphere ---------- */
    let labels = [], labelIndex = new Map(), slots = [];
    function buildLabels() {
      labels = []; labelIndex = new Map();
      const ag = V.agents.slice().sort((a, b) => (a.id === "main" ? -1 : b.id === "main" ? 1 : ((b.counts && b.counts.tools) || 0) - ((a.counts && a.counts.tools) || 0)));
      const agentCount = Math.min(ag.length, 6);
      for (let k = 0; k < agentCount; k++) labels.push({ key: "a:" + ag[k].id, name: ag[k].name || ag[k].id, type: "agent" });
      const files = (V.v.fileHeat || []).slice().sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes));
      for (let k = 0; k < files.length && labels.length < 13; k++) labels.push({ key: "f:" + files[k].path, name: baseName(files[k].path), type: "file", path: files[k].path });
      const seen = new Map();
      for (const l of labels) if (l.type === "agent") seen.set(l.name, (seen.get(l.name) || 0) + 1);
      const order = new Map();
      for (const l of labels) if (l.type === "agent" && seen.get(l.name) > 1) { const k = (order.get(l.name) || 0) + 1; order.set(l.name, k); l.name = l.name + " " + k; }
      labels.forEach((l, k) => labelIndex.set(l.key, k));
    }
    function computeSlots() {
      const v = CV.sphere, w = v.w, h = v.h;
      slots = [];
      const narrow = w < 560;
      const cx = w / 2, cy = h * 0.5 + 4;
      const rx = Math.max(60, w / 2 - (narrow ? 46 : 74)), ry = Math.max(60, h / 2 - 22);
      const positions = [];
      for (let k = 1; k <= 13; k++) if (!narrow || k % 2 === 0) positions.push(k);
      const angle = (k) => (-90 + (k * 360) / 14) * (Math.PI / 180);
      labels.forEach((l, i) => {
        if (i >= positions.length) { slots.push(null); return; }
        const a = angle(positions[i]);
        slots.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
      });
      slots.fallback = { x: cx, y: cy - ry };
      slots.narrow = narrow;
    }

    /* ---------- sphere ---------- */
    const DOTS = 1500, SPIKES = 240;
    const KX = new Float32Array(DOTS), KY = new Float32Array(DOTS), KZ = new Float32Array(DOTS);
    const SX = new Float32Array(SPIKES), SYY = new Float32Array(SPIKES), SZ = new Float32Array(SPIKES), SU2 = new Float32Array(SPIKES);
    (function buildSphere() {
      const golden = Math.PI * (3 - Math.sqrt(5)), r = seeded(7);
      for (let k = 0; k < DOTS; k++) {
        const y = (k + 0.5) / DOTS, q = Math.sqrt(1 - y * y), th = k * golden;
        KX[k] = q * Math.cos(th); KY[k] = y; KZ[k] = q * Math.sin(th);
      }
      for (let k = 0; k < SPIKES; k++) {
        const y = Math.pow(r(), 0.8), q = Math.sqrt(1 - y * y), th = r() * Math.PI * 2;
        SX[k] = q * Math.cos(th); SYY[k] = y; SZ[k] = q * Math.sin(th); SU2[k] = 0.18 + r() * r() * 0.55;
      }
    })();
    const TILT = 0.38, cT = Math.cos(TILT), sT = Math.sin(TILT);
    const buckets = [[], [], [], []];
    const BUCKET_SIZE = [0.9, 1.25, 1.6, 2.0], BUCKET_ALPHA = [0.2, 0.42, 0.7, 0.95];
    const slotOf = (key) => { const i = labelIndex.get(key); return i != null && slots[i] ? slots[i] : null; };

    function drawSphere(ts) {
      const v = CV.sphere, x = clearCanvas(v), w = v.w, h = v.h;
      const cx = w / 2, R = Math.min(w * 0.27, h * 0.33), by = h * 0.5 + R * 0.4;
      const rot = reducedMotion ? 0.6 : ts * 0.00013;
      const ca = Math.cos(rot), sa = Math.sin(rot);

      /* floor ring (and a soft glow in the neon theme only) */
      x.save();
      x.translate(cx, by); x.scale(1, 0.38);
      if (!C.flat) {
        const g = x.createRadialGradient(0, 0, 0, 0, 0, R * 1.35);
        g.addColorStop(0, rgba(C.accent, 0.30)); g.addColorStop(0.6, rgba(C.accent, 0.07)); g.addColorStop(1, rgba(C.accent, 0));
        x.fillStyle = g; x.beginPath(); x.arc(0, 0, R * 1.35, 0, 7); x.fill();
      }
      x.strokeStyle = C.flat ? rgba(C.line2, 0.9) : rgba(C.dotsNear, 0.35); x.lineWidth = 1; x.beginPath(); x.arc(0, 0, R * 1.02, 0, 7); x.stroke();
      x.strokeStyle = C.flat ? rgba(C.line2, 0.5) : rgba(C.dotsNear, 0.14); x.beginPath(); x.arc(0, 0, R * 1.3, 0, 7); x.stroke();
      x.restore();

      /* spikes */
      x.lineWidth = 0.7;
      for (let pass = 0; pass < 2; pass++) {
        x.beginPath();
        for (let k = 0; k < SPIKES; k++) {
          const px = SX[k] * ca + SZ[k] * sa, pz = -SX[k] * sa + SZ[k] * ca;
          const near = (SYY[k] * sT + pz * cT) > 0 ? 1 : 0;
          if (near !== pass) continue;
          const u = 1 + SU2[k];
          const ay = SYY[k] * cT - pz * sT;
          x.moveTo(cx + px * R, by - ay * R);
          x.lineTo(cx + px * R * u, by - (SYY[k] * u * cT - pz * u * sT) * R);
        }
        x.strokeStyle = rgba(C.dotsNear, C.flat ? (pass ? 0.45 : 0.18) : (pass ? 0.34 : 0.14)); x.stroke();
      }

      /* dots */
      for (let b = 0; b < 4; b++) buckets[b].length = 0;
      for (let k = 0; k < DOTS; k++) {
        const px = KX[k] * ca + KZ[k] * sa, pz = -KX[k] * sa + KZ[k] * ca;
        const d = (KY[k] * sT + pz * cT + 1) / 2; // 0 far .. 1 near
        const b = d < 0.3 ? 0 : d < 0.5 ? 1 : d < 0.72 ? 2 : 3;
        buckets[b].push(cx + px * R, by - (KY[k] * cT - pz * sT) * R);
      }
      for (let b = 0; b < 4; b++) {
        const arr = buckets[b], s = BUCKET_SIZE[b];
        x.beginPath();
        for (let k = 0; k < arr.length; k += 2) x.rect(arr[k] - s / 2, arr[k + 1] - s / 2, s, s);
        x.fillStyle = rgba(b === 3 ? C.dotsNear : C.dots, BUCKET_ALPHA[b] * (C.flat ? 0.8 : 1)); x.fill();
      }

      /* labels and beam */
      x.font = "11px " + C.mono; x.textBaseline = "middle"; x.textAlign = "center";
      const hub = { x: cx, y: by - R * 0.3 };
      const maxLen = slots.narrow ? 11 : 18;
      let hotSlot = null, hotText = "";
      if (target) {
        hotSlot = slotOf(target.key);
        if (!hotSlot) hotSlot = slots.fallback;
        hotText = up(cut(target.name, maxLen));
      }
      const hotIdx = target ? labelIndex.get(target.key) : undefined;
      if (target && hotSlot) {
        const dx = hotSlot.x - hub.x, dy = hotSlot.y - hub.y, len = Math.hypot(dx, dy) || 1;
        const bx = hotSlot.x - (dx / len) * 12, by2 = hotSlot.y - (dy / len) * 12;
        x.setLineDash([]); x.lineWidth = 1.2; x.strokeStyle = rgba(C.accent, 0.55);
        x.beginPath(); x.moveTo(hub.x, hub.y); x.lineTo(bx, by2); x.stroke();
        x.lineWidth = 2.4; x.setLineDash([3, 10]);
        const phase = reducedMotion ? 0 : ts * 0.05;
        x.lineDashOffset = target.dir === "in" ? phase : -phase;
        x.strokeStyle = C.accentSoft; x.beginPath(); x.moveTo(hub.x, hub.y); x.lineTo(bx, by2); x.stroke();
        x.setLineDash([]); x.lineDashOffset = 0;
        x.fillStyle = C.accentSoft; x.beginPath(); x.arc(hub.x, hub.y, 3, 0, 7); x.fill();
      }
      const drawLabel = (px, py, text, hot, agent) => {
        const mw = x.measureText(text).width + 12, mh = 18;
        const lx = clamp(px - mw / 2, 3, w - mw - 3), ly = clamp(py - mh / 2, 3, h - mh - 3);
        if (hot) {
          x.fillStyle = C.accent; x.fillRect(lx, ly, mw, mh);
          x.fillStyle = C.flat ? "#fbf6ee" : C.bg; x.font = "bold 11px " + C.mono;
          x.fillText(text, lx + mw / 2, ly + mh / 2 + 0.5); x.font = "11px " + C.mono;
        } else {
          x.fillStyle = rgba(C.bg, C.flat ? 0.9 : 0.55); x.fillRect(lx, ly, mw, mh);
          if (agent) { x.strokeStyle = rgba(C.flat ? C.accent : C.accentSoft, 0.5); x.lineWidth = 1; x.strokeRect(lx + 0.5, ly + 0.5, mw - 1, mh - 1); }
          x.fillStyle = agent ? (C.flat ? C.accent : C.accentSoft) : C.muted;
          x.fillText(text, lx + mw / 2, ly + mh / 2 + 0.5);
        }
      };
      labels.forEach((l, i) => {
        const p = slots[i]; if (!p || i === hotIdx) return;
        drawLabel(p.x, p.y, up(cut(l.name, maxLen)), false, l.type === "agent");
      });
      if (target && hotSlot) drawLabel(hotSlot.x, hotSlot.y, hotText, true, false);
    }

    /* ---------- small charts ---------- */
    function drawScan() {
      const v = CV.scan, x = clearCanvas(v), w = v.w, h = v.h;
      x.strokeStyle = rgba(C.line2, 0.6); x.lineWidth = 1;
      x.beginPath(); x.moveTo(0, h - 3.5); x.lineTo(w, h - 3.5); x.stroke();
      const i = lastIdx;
      if (!V || i < 1) { D.scanSub.textContent = t("waiting for data"); return; }
      const a = Math.max(0, i - 59), t0 = V.TA[a], t1 = V.TA[i], NBk = 32, bins = new Array(NBk).fill(0);
      for (let k = a; k <= i; k++) bins[t1 > t0 ? Math.min(NBk - 1, Math.floor(((V.TA[k] - t0) / (t1 - t0)) * NBk)) : NBk - 1]++;
      const s = bins.map((_, b) => (bins[Math.max(0, b - 1)] + 2 * bins[b] + bins[Math.min(NBk - 1, b + 1)]) / 4);
      const mx = Math.max(1, ...s);
      const px = (b) => 3 + (b / (NBk - 1)) * (w - 6), py = (val) => h - 6 - (val / mx) * (h - 14);
      x.beginPath(); x.moveTo(px(0), py(s[0]));
      for (let b = 1; b < NBk; b++) { const mxp = (px(b - 1) + px(b)) / 2, myp = (py(s[b - 1]) + py(s[b])) / 2; x.quadraticCurveTo(px(b - 1), py(s[b - 1]), mxp, myp); }
      x.lineTo(px(NBk - 1), py(s[NBk - 1]));
      x.strokeStyle = C.sand; x.lineWidth = 1.4; x.stroke();
      const minutes = Math.max(t1 - t0, 1000) / 60000;
      D.scanSub.textContent = t("last {n} events · {rate} events/min (active)", { n: i - a + 1, rate: Math.round((i - a + 1) / minutes) });
    }

    function buildCostCache() {
      const v = CV.cost, w = v.w, h = v.h, dpr = v.dpr;
      for (const c of [costBase, costLit]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const L = 6, Rr = 6, Top = 14, Bot = 16, pw = w - L - Rr, ph = h - Top - Bot;
      const totalT = totalMs(), mx = Math.max(V.usdTotal, 0.000001);
      const nx = (ms) => L + (ms / totalT) * pw, ny = (u) => Top + ph - (u / mx) * ph;
      for (let pass = 0; pass < 2; pass++) {
        const x = (pass ? costLit : costBase).getContext("2d");
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!pass) {
          x.strokeStyle = rgba(C.line, 0.9); x.lineWidth = 1;
          for (let g = 0; g <= 3; g++) { const yy = Math.round(Top + (ph * g) / 3) + 0.5; x.beginPath(); x.moveTo(L, yy); x.lineTo(w - Rr, yy); x.stroke(); }
          x.fillStyle = C.muted; x.font = "10px " + C.mono; x.textBaseline = "alphabetic";
          x.textAlign = "left"; x.fillText(V.startMs ? dayClock(0) : "", L, h - 3);
          x.textAlign = "right"; x.fillText(V.startMs ? dayClock((V.n ? V.T[V.n - 1] : 0)) : "", w - Rr, h - 3);
        }
        x.beginPath(); x.moveTo(nx(0), ny(0));
        let lastX = nx(0), lastY = ny(0);
        for (let k = 0; k < V.ns; k++) { lastX = nx(V.ST[k]); lastY = ny(V.SU[k]); x.lineTo(lastX, lastY); }
        x.lineTo(nx(totalT), lastY);
        x.strokeStyle = pass ? C.sand : rgba(C.sand, 0.28); x.lineWidth = pass ? 1.6 : 1; x.stroke();
        if (pass) {
          x.lineTo(nx(totalT), ny(0)); x.lineTo(nx(0), ny(0)); x.closePath();
          if (C.flat) x.fillStyle = rgba(C.sand, 0.10);
          else { const gr = x.createLinearGradient(0, Top, 0, Top + ph); gr.addColorStop(0, rgba(C.sand, 0.2)); gr.addColorStop(1, rgba(C.sand, 0)); x.fillStyle = gr; }
          x.fill();
        }
      }
      costReady = true;
    }
    function drawCost() {
      if (!V) return;
      if (!costReady) buildCostCache();
      const v = CV.cost, x = clearCanvas(v), w = v.w, h = v.h, dpr = v.dpr;
      const L = 6, Rr = 6, Top = 14, Bot = 16, pw = w - L - Rr, ph = h - Top - Bot, totalT = totalMs();
      const px = L + clamp(pos / totalT, 0, 1) * pw;
      x.drawImage(costBase, 0, 0, w, h);
      const kw = Math.max(1, Math.round(px * dpr));
      x.drawImage(costLit, 0, 0, Math.min(kw, costLit.width), costLit.height, 0, 0, Math.min(kw, costLit.width) / dpr, h);
      const hi = lastAtOrBelow(V.ST, pos, V.ns);
      const u = hi >= 0 ? V.SU[hi] : 0, py = Top + ph - (u / Math.max(V.usdTotal, 0.000001)) * ph;
      x.strokeStyle = rgba(C.accent, 0.5); x.lineWidth = 1; x.beginPath(); x.moveTo(px + 0.5, Top - 4); x.lineTo(px + 0.5, Top + ph); x.stroke();
      if (!C.flat) { x.fillStyle = rgba(C.accent, 0.3); x.beginPath(); x.arc(px, py, 7, 0, 7); x.fill(); }
      x.fillStyle = C.accent; x.beginPath(); x.arc(px, py, 3.5, 0, 7); x.fill();
      x.fillStyle = C.text; x.font = "10px " + C.mono; x.textAlign = px > w - 70 ? "right" : "left"; x.textBaseline = "alphabetic";
      x.fillText(usdText(u), px + (px > w - 70 ? -8 : 8), Math.max(Top, py - 8));
    }
    function drawDensity() {
      const v = CV.density, x = clearCanvas(v), w = v.w, h = v.h;
      if (!V) return;
      const NB = V.NB, bw0 = (w - 4) / NB, totalT = totalMs(), act = clamp(Math.floor((pos / totalT) * NB), 0, NB - 1);
      for (let b = 0; b < NB; b++) {
        const bh = Math.max(V.sliceCount[b] ? 2 : 0, Math.sqrt(V.sliceCount[b] / V.sliceMax) * (h - 14));
        const errs = V.sliceErrors[b], passed = b <= act, bw = Math.max(1, bw0 - 1.5), bx = 2 + b * bw0;
        x.fillStyle = rgba(C.sand, passed ? 0.78 : 0.24);
        x.fillRect(bx, h - 4 - bh, bw, bh);
        if (errs > 0) { // the error part sits on top in the accent color
          const eh = Math.min(bh, Math.max(3, bh * (errs / V.sliceCount[b])));
          x.fillStyle = rgba(C.accent, passed ? 1 : 0.5); x.fillRect(bx, h - 4 - bh, bw, eh);
        }
      }
      const mx = 2 + (pos / totalT) * (w - 4);
      x.fillStyle = C.accent; x.fillRect(Math.round(mx), 0, 1.5, h - 2);
      x.beginPath(); x.moveTo(mx - 4, 0); x.lineTo(mx + 5, 0); x.lineTo(mx + 0.5, 6); x.fill();
    }

    /* mini agent network */
    let netNodes = [], netEdges = [];
    function buildNetwork() {
      const ag = V.agents;
      netNodes = ag.map((a) => ({ id: a.id, name: a.name || a.id, x: 0, y: 0 }));
      const idx = new Map(netNodes.map((d, i) => [d.id, i]));
      netEdges = [];
      for (const a of ag) if (a.parent && idx.has(a.parent)) netEdges.push([idx.get(a.parent), idx.get(a.id), 0]);
      const seen = new Set();
      for (const h of V.v.handoffs || []) {
        const p = idx.get(h.writer), q = idx.get(h.reader);
        if (p == null || q == null || p === q) continue;
        const key = p + ">" + q; if (seen.has(key)) continue; seen.add(key); netEdges.push([p, q, 1]);
      }
      D.netSub.textContent = up(t("{agents} agents · {handoffs} handoffs", { agents: ag.length, handoffs: seen.size }));
    }
    function drawNetwork() {
      const v = CV.net, x = clearCanvas(v), w = v.w, h = v.h;
      const n = netNodes.length; if (!n) return;
      const cx = w / 2, cy = h / 2, rxA = Math.max(20, w / 2 - 34), ryA = Math.max(20, h / 2 - 14);
      const mainIdx = netNodes.findIndex((d) => d.id === "main");
      let k = 0; const outer = n - (mainIdx >= 0 ? 1 : 0);
      netNodes.forEach((d, i) => {
        if (i === mainIdx) { d.x = cx; d.y = cy; return; }
        const a = (k / Math.max(1, outer)) * Math.PI * 2 - Math.PI / 2; k++;
        const rr = outer > 14 && k % 2 ? 0.7 : 1;
        d.x = cx + Math.cos(a) * rxA * rr; d.y = cy + Math.sin(a) * ryA * rr;
      });
      const now = target && V.ev[lastIdx] ? V.ev[lastIdx].agent : null;
      for (const [p, q, kind] of netEdges) {
        x.strokeStyle = kind ? rgba(C.sand, 0.55) : rgba(C.line2, 0.9); x.lineWidth = kind ? 1.1 : 0.8;
        x.setLineDash(kind ? [3, 3] : []); x.beginPath(); x.moveTo(netNodes[p].x, netNodes[p].y); x.lineTo(netNodes[q].x, netNodes[q].y); x.stroke();
      }
      x.setLineDash([]);
      x.font = "10px " + C.mono; x.textBaseline = "middle";
      for (const d of netNodes) {
        const hot = d.id === now;
        x.fillStyle = hot ? C.accent : d.id === "main" ? C.sand : rgba(C.muted, 0.85);
        x.beginPath(); x.arc(d.x, d.y, hot ? 5 : d.id === "main" ? 4.5 : 2.8, 0, 7); x.fill();
        if (hot) { x.strokeStyle = rgba(C.accent, 0.5); x.lineWidth = 1; x.beginPath(); x.arc(d.x, d.y, 9, 0, 7); x.stroke(); }
      }
      const g = netNodes.find((d) => d.id === now);
      if (g) {
        const m = up(cut(g.name, 16)); x.textAlign = "center"; x.fillStyle = C.accentSoft;
        x.fillText(m, clamp(g.x, 46, w - 46), clamp(g.y < h / 2 ? g.y + 15 : g.y - 15, 8, h - 8));
      }
    }

    /* ---------- panels ---------- */
    function buildGauges() {
      D.gauges.textContent = "";
      const tt = V.v.totals || {};
      let tools = 0, reads = 0;
      for (const a of V.agents) { tools += (a.counts && a.counts.tools) || 0; reads += (a.counts && a.counts.read) || 0; }
      const cacheShare = (tt.cacheRead || 0) / Math.max(1, (tt.cacheRead || 0) + (tt.input || 0) + (tt.cacheWrite || 0));
      const rows = [
        [t("Error rate"), (tt.errors || 0) / Math.max(1, tools), true, t("{n} errors", { n: tt.errors || 0 })],
        [t("Retries"), (tt.retries || 0) / Math.max(1, tools), true, t("{n} times", { n: tt.retries || 0 })],
        [t("Redundant reads"), (tt.redundantReads || 0) / Math.max(1, reads), true, t("{n} reads", { n: tt.redundantReads || 0 })],
        [t("Cache share"), cacheShare, false, ""],
      ];
      for (const [name, ratio, bad, extra] of rows) {
        const box = el("div", "cmd-gauge");
        box.appendChild(el("span", "cmd-gauge-name", name));
        box.appendChild(el("span", "cmd-gauge-value", t("{n}%", { n: (ratio * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) }) + (extra ? " · " + extra : "")));
        const seg = el("div", "cmd-segments" + (bad ? " cmd-segments--bad" : ""), null, { role: "img", "aria-label": name + " " + t("{n}%", { n: Math.round(ratio * 100) }) });
        const filled = ratio > 0 ? Math.max(1, Math.round(ratio * 10)) : 0;
        for (let k = 0; k < 10; k++) seg.appendChild(el("i", k < filled ? "cmd-filled" : ""));
        box.appendChild(seg); D.gauges.appendChild(box);
      }
    }
    function buildModelPanel() {
      D.models.textContent = "";
      D.modelRows = new Map();
      const list = [...V.modelTotals.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 6);
      if (!list.length) { D.models.appendChild(el("div", "cmd-empty", t("No model data."))); return; }
      for (const [model] of list) {
        const g = el("div", "cmd-model-group");
        const name = el("div", "cmd-model-name"); const a1 = el("span", null, model.replace(/^claude-/, "")); const a2 = el("span", null, "");
        name.append(a1, a2);
        const c1 = el("div", "cmd-bar cmd-bar--sand", null, { title: t("output tokens") }); const i1 = el("i"); c1.appendChild(i1);
        const c2 = el("div", "cmd-bar", null, { title: "USD" }); const i2 = el("i"); c2.appendChild(i2);
        g.append(name, c1, c2); D.models.appendChild(g);
        D.modelRows.set(model, { a2, i1, i2 });
      }
    }
    function updateModelPanel() {
      if (!D.modelRows) return;
      let maxOut = 1, maxUsd = 1;
      for (const [k] of D.modelRows) { const tt = V.modelTotals.get(k); maxOut = Math.max(maxOut, tt.out); maxUsd = Math.max(maxUsd, tt.usd); }
      for (const [k, s] of D.modelRows) {
        const m = SY.models.get(k) || { usd: 0, out: 0 };
        setText(s.a2, fmt.tokens(m.out) + " · " + usdText(m.usd));
        const w1 = (m.out / maxOut * 100).toFixed(1) + "%", w2 = (m.usd / maxUsd * 100).toFixed(1) + "%";
        if (s.i1._w !== w1) { s.i1._w = w1; s.i1.style.width = w1; }
        if (s.i2._w !== w2) { s.i2._w = w2; s.i2.style.width = w2; }
      }
    }
    function updateFilePanel() {
      const top3 = [];
      for (const d of SY.files.values()) {
        const s = d.reads + d.writes;
        if (top3.length < 3 || s > top3[2].reads + top3[2].writes) {
          top3.push(d); top3.sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes)); if (top3.length > 3) top3.pop();
        }
      }
      while (D.files.querySelectorAll(".cmd-file").length < 3) {
        const row = el("div", "cmd-file"); const nm = el("span", "cmd-file-name", ""); const cnt = el("span", "cmd-file-count", ""); const bar = el("div", "cmd-bar"); bar.appendChild(el("i"));
        row.append(nm, cnt, bar); D.files.appendChild(row);
      }
      const mx = top3.length ? top3[0].reads + top3[0].writes : 1;
      for (let k = 0; k < 3; k++) {
        const row = D.files.querySelectorAll(".cmd-file")[k], d = top3[k];
        row.style.visibility = d ? "visible" : "hidden";
        if (!d) continue;
        const nm = row.firstChild; setText(nm, d.name); setText(row.children[1], d.reads + d.writes);
        nm.title = d.path + " — " + t("{w} writes, {r} reads", { w: d.writes, r: d.reads });
        const w = (((d.reads + d.writes) / mx) * 100).toFixed(1) + "%";
        const bar = row.lastChild.firstChild; if (bar._w !== w) { bar._w = w; bar.style.width = w; }
      }
      if (!D.filesEmpty) { D.filesEmpty = el("div", "cmd-empty", t("No file read or written yet.")); D.files.appendChild(D.filesEmpty); }
      D.filesEmpty.hidden = top3.length > 0;
    }
    function buildPromptList() {
      D.promptList.textContent = "";
      D.promptButtons = [];
      const l = V.prompts;
      D.promptTitle.textContent = t("Session / prompts") + (l.length ? " · " + l.length : "");
      if (!l.length) { D.promptList.appendChild(el("li", "cmd-empty", t("No prompts recorded."))); return; }
      l.forEach((s) => {
        const li = el("li");
        const b = el("button", "cmd-prompt", null, { type: "button", title: s.text });
        const d = new Date(V.startMs + s.t);
        const clock = (V.multiDay ? two(d.getDate()) + "." + two(d.getMonth() + 1) + " " : "") + two(d.getHours()) + ":" + two(d.getMinutes());
        b.append(el("span", "cmd-prompt-time", clock), el("span", "cmd-prompt-text", cut(s.text.replace(/\s+/g, " "), 110)));
        listen(b, "click", () => { following = false; setPosition(s.ta); });
        li.appendChild(b); D.promptList.appendChild(li); D.promptButtons.push(b);
      });
    }
    function dayClock(ms) {
      const d = new Date(V.startMs + ms);
      return two(d.getDate()) + "." + two(d.getMonth() + 1) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
    }

    /* ---------- progress: counters and update ---------- */
    function advanceCounters(i, si) {
      if (i < SY.idx || si < SY.sIdx) { SY.idx = -1; SY.sIdx = -1; SY.files.clear(); SY.models.clear(); }
      for (let k = SY.idx + 1; k <= i; k++) {
        const o = V.ev[k];
        if (o.path && (o.kind === "read" || o.kind === "write")) {
          let d = SY.files.get(o.path); if (!d) { d = { path: o.path, name: baseName(o.path), reads: 0, writes: 0 }; SY.files.set(o.path, d); }
          if (o.kind === "read") d.reads++; else d.writes++;
        }
      }
      SY.idx = i;
      for (let k = SY.sIdx + 1; k <= si; k++) {
        const h = V.sp[k]; let m = SY.models.get(h[2]); if (!m) { m = { usd: 0, out: 0 }; SY.models.set(h[2], m); }
        m.usd += h[3] || 0; m.out += h[4] || 0;
      }
      SY.sIdx = si;
    }
    function modelOf(agentId, realMs) {
      const m = V.agentModel.get(agentId);
      if (m) { const j = lastAtOrBelow(m.t, realMs, m.t.length); return m.m[j < 0 ? 0 : j]; }
      const a = V.agentById.get(agentId);
      return a && a.models && a.models[0] ? a.models[0].model : "";
    }
    function findTarget(o) {
      const dir = INWARD[o.kind] ? "in" : "out";
      if (o.path) return { key: "f:" + o.path, name: baseName(o.path), dir };
      let id = o.agent;
      if (o.kind === "agent") {
        const name = String(o.summary || "").split(":")[0].trim(); let best = null, gap = Infinity;
        for (const a of V.agents) if (a.parent === o.agent && a.name === name) { const f = Math.abs(a.firstMs - o.t); if (f < gap) { gap = f; best = a; } }
        if (best) id = best.id;
      }
      const a = V.agentById.get(id);
      return { key: "a:" + id, name: a ? a.name || id : String(id), dir };
    }

    function update() {
      if (!V) return;
      const i = V.n ? lastAtOrBelow(V.TA, pos, V.n) : -1;
      const si = V.ns ? lastAtOrBelow(V.ST, pos, V.ns) : -1;
      const idxChanged = i !== lastIdx || force;

      const realT = i >= 0 ? V.T[i] + (pos - V.TA[i]) : 0;
      setText(D.usd, usdText(si >= 0 ? V.SU[si] : 0));
      setText(D.tok, fmt.tokens(si >= 0 ? V.SC[si] : 0));
      setText(D.clock, V.startMs ? dayClock(realT) : "—");
      setText(D.clockSub, t("active time {a} / {b}", { a: clockText(pos), b: clockText(V.total) }));
      const sv = Math.round((pos / totalMs()) * 10000);
      if (+D.slider.value !== sv) D.slider.value = String(sv);
      D.slider.setAttribute("aria-valuetext", clockText(pos) + " / " + clockText(V.total));

      if (si !== lastSpend || idxChanged) { advanceCounters(Math.max(i, -1), si); updateModelPanel(); lastSpend = si; }

      if (idxChanged) {
        lastIdx = i; force = false;
        const o = i >= 0 ? V.ev[i] : null;
        target = o ? Object.assign(findTarget(o), { error: !!o.error }) : null;
        updateMatrix(i);
        updateCard(o, i);
        updateFilePanel();
        updateLog(i);
        drawScan();
        drawNetwork();
      }
      const pi = V.prompts.length ? lastAtOrBelow(V.promptTA, pos, V.prompts.length) : -1;
      if (pi !== lastPrompt) {
        if (D.promptButtons) {
          if (lastPrompt >= 0 && D.promptButtons[lastPrompt]) { D.promptButtons[lastPrompt].classList.remove("cmd-prompt--now"); D.promptButtons[lastPrompt].removeAttribute("aria-current"); }
          const b = D.promptButtons[pi];
          if (b) {
            b.classList.add("cmd-prompt--now"); b.setAttribute("aria-current", "true");
            const L = D.promptList, topY = b.parentNode.offsetTop, bottomY = topY + b.parentNode.offsetHeight;
            if (topY < L.scrollTop || bottomY > L.scrollTop + L.clientHeight) L.scrollTop = Math.max(0, topY - L.clientHeight / 2 + b.offsetHeight / 2);
          }
        }
        lastPrompt = pi;
      }
      drawCost();
      drawDensity();
      lastPos = pos;
    }

    function updateMatrix(i) {
      const filled = [[], [], []];
      for (let k = i, look = 0; k >= 0 && look < 700 && (filled[0].length < 6 || filled[1].length < 6 || filled[2].length < 6); k--, look++) {
        const g = GROUP[V.ev[k].kind];
        if (g != null && filled[g].length < 6) filled[g].unshift(k);
      }
      for (let g = 0; g < 3; g++) {
        const arr = filled[g], cells = D.cells[g], empty = 6 - arr.length;
        for (let c = 0; c < 6; c++) {
          const k = c < empty ? -1 : arr[c - empty], cell = cells[c];
          setText(cell, k >= 0 ? shortLabel(V.ev[k]) : "·");
          cell.classList.toggle("cmd-cell--now", k >= 0 && k === i);
          if (k >= 0 && cell._t !== k) { cell._t = k; cell.title = V.ev[k].kind + " · " + (V.ev[k].summary || ""); }
        }
      }
    }
    function updateCard(o, i) {
      const clock = clockText(pos);
      if (!o) {
        setText(D.cardTop, clock + " / " + up(t("ready"))); setText(D.cardBig, t("Session starting")); setText(D.cardSub, t("{agents} agents · {events} events", { agents: V.agents.length, events: fmt.num(V.n) }));
        D.card.classList.remove("cmd-card--error"); D.cardError.hidden = true;
        setText(D.state, up(t("waiting"))); D.state.classList.remove("cmd-state-word--error"); setText(D.stateModel, "");
        return;
      }
      const kind = KIND_NAME()[o.kind] ? o.kind : "other";
      const ag = V.agentById.get(o.agent);
      const model = modelOf(o.agent, o.t);
      const agentName = ag ? ag.name || ag.id : String(o.agent);
      setText(D.cardTop, clock + " / " + up(KIND_NAME()[kind]));
      setText(D.cardBig, up(STATE_WORD()[kind]) + " → " + targetText(o));
      D.cardBig.title = o.summary || "";
      D.card.classList.toggle("cmd-card--error", !!o.error);
      D.cardError.hidden = !o.error;
      setText(D.cardSub, o.error ? up(t("error")) + ": " + cut(String(o.error).replace(/\s+/g, " "), 170) : agentName + " · " + (model || t("model unknown")));
      const idle = i + 1 < V.n && V.TA[i + 1] - V.TA[i] >= GAP_LIMIT && pos - V.TA[i] > 3000;
      setText(D.state, o.error ? up(t("error")) : idle ? up(t("waiting")) : up(STATE_WORD()[kind]));
      D.state.classList.toggle("cmd-state-word--error", !!o.error);
      setText(D.stateModel, agentName + " · " + (model || t("model unknown")));
    }
    function updateLog(i) {
      const first = Math.max(0, i - 7);
      const rows = [];
      for (let k = first; k <= i && k >= 0; k++) rows.push(k);
      while (D.log.children.length < 8) { const li = el("li"); li.append(el("span", null, ""), el("span", null, "")); D.log.appendChild(li); }
      for (let r = 0; r < 8; r++) {
        const li = D.log.children[r], k = rows[r];
        if (k == null) { setText(li.firstChild, ""); setText(li.lastChild, ""); li.classList.remove("cmd-log-error"); continue; }
        const o = V.ev[k];
        setText(li.firstChild, String(k + 1).padStart(4, "0"));
        setText(li.lastChild, (o.error ? up(t("error")) + " · " : "") + (o.kind || "") + " " + targetText(o));
        li.classList.toggle("cmd-log-error", !!o.error);
        li.title = o.error ? String(o.error).slice(0, 200) : o.summary || "";
      }
    }

    /* ---------- playback control ---------- */
    function setPosition(p) {
      pos = clamp(p, 0, V ? V.total : 0);
      update();
    }
    function togglePlay() {
      if (!V || !V.n) return;
      if (playing) { playing = false; following = false; }
      else { if (pos >= V.total) pos = 0; playing = true; lastFrame = 0; startLoop(); }
      updatePlayButton();
    }
    function updatePlayButton() {
      D.play.textContent = playing ? t("Pause") : (V && pos >= V.total && V.total > 0 ? t("Replay") : t("Play"));
      D.goLive.setAttribute("aria-pressed", following ? "true" : "false");
    }
    function goToPrompt(dir) {
      if (!V || !V.prompts.length) return;
      following = false;
      const l = V.promptTA; let idx = -1;
      if (dir < 0) { for (let k = l.length - 1; k >= 0; k--) if (l[k] < pos - 300) { idx = k; break; } idx = idx < 0 ? 0 : idx; }
      else { for (let k = 0; k < l.length; k++) if (l[k] > pos + 1) { idx = k; break; } if (idx < 0) idx = l.length - 1; }
      setPosition(l[idx]);
    }
    function followLive() {
      if (!V || !V.live) return;
      following = !following;
      if (following) { pos = V.total; playing = true; lastFrame = 0; startLoop(); loadSession(selectedId, true); update(); }
      updatePlayButton();
    }
    function setupPolling() {
      clearInterval(poller); poller = 0;
      if (V && V.live) poller = setInterval(() => { if (!document.hidden && following && !closed) loadSession(selectedId, true); }, 3000);
    }

    /* ---------- loop ---------- */
    let lastSphereIdx = -3;
    function frame(ts) {
      raf = 0;
      if (closed || document.hidden) return;
      const dt = lastFrame ? Math.min(100, ts - lastFrame) : 0; lastFrame = ts;
      if (V && playing && V.total > 0 && !reducedMotion) {
        pos = Math.min(V.total, pos + dt * (V.total / (speedSec * 1000)));
        if (pos >= V.total && !following) { playing = false; updatePlayButton(); }
      }
      if (V && (pos !== lastPos || force)) update();
      if (V && CV.sphere.w > 10) { if (!reducedMotion || force || lastSphereIdx !== lastIdx) { drawSphere(ts); lastSphereIdx = lastIdx; } }
      raf = requestAnimationFrame(frame);
    }
    function startLoop() { if (!raf && !closed && !document.hidden) { lastFrame = 0; raf = requestAnimationFrame(frame); } }
    listen(document, "visibilitychange", () => {
      if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
      else startLoop();
    });

    /* ---------- start / close ---------- */
    async function start() {
      if (abort) abort.abort();
      abort = new AbortController();
      showLoading(up(t("loading session list…")));
      try {
        sessions = await fetchSessions();
        if (closed) return;
        const id = options && options.sessionId && sessions.some((o) => o.id === options.sessionId) ? options.sessionId : sessions[0] && sessions[0].id;
        if (!id) { fillSelect(); showLoading(t("No session to show.")); D.spinner.hidden = true; return; }
        selectedId = id; fillSelect();
        await loadSession(id);
      } catch (err) {
        if (closed || (err && err.name === "AbortError")) return;
        showLoading(up(t("error")) + ": " + (err && err.message ? err.message : t("unknown error")), true);
      }
    }
    start();

    return {
      close() {
        closed = true;
        if (raf) cancelAnimationFrame(raf); raf = 0;
        clearInterval(poller);
        if (abort) abort.abort();
        if (ro) ro.disconnect();
        cleanups.forEach((f) => f());
        container.textContent = "";
        container.classList.remove("cmd-root");
        V = null;
      },
    };
  }

  /* ---------- contract ---------- */
  let active = null;
  window.PanoCommand = {
    open(container, options) { if (active) active.close(); active = createInstance(container, options || {}); },
    close() { if (active) { active.close(); active = null; } },
  };
})();
