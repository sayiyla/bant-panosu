// Session reader: parses Claude Code transcripts (<claude home>/projects/<encoded project path>/*.jsonl and
// <session>/subagents/agent-*.jsonl). It extracts who (main session or subagent) read which file, wrote which file,
// ran which command, which model and how many tokens were used, and where errors happened.
// It never writes anything, installs no hooks and has no dependencies: it works for any project Claude Code was used in.
// Limit: files written through Bash/PowerShell are not visible (only the command is).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SESSION_ID = /^[0-9a-f-]{36}$/;
const REPLAY_LIMIT = 6000;

export interface SessionEvent { time: string; agent: string; tool: string; kind: string; summary: string; path?: string; id?: string; error?: string }
interface Usage { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
interface SubagentMeta { agentType?: string; description?: string; toolUseId?: string; model?: string; effort?: string; finished?: boolean }
interface Price { input: number; output: number; cacheRead: number }
interface PriceTable { cacheWriteMultiplier: number; models: Record<string, Price>; source?: string }

/** No secret value should survive in displayed text: KEY=value pairs, bearer tokens and well-known token shapes are masked, then the text is shortened. */
export function redact(text: string, length = 160): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]")
    .replace(/\b([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|COOKIE|AUTH|CREDENTIAL)[A-Za-z0-9_-]*\s*[=:]\s*(?:(?:Bearer|Basic)\s+)?)("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/(--(?:password|token|api-key|secret)[= ])\S+/gi, "$1***")
    .replace(/\b(Bearer\s+)\S+/gi, "$1***")
    .replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***")
    .replace(/\b((?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9]{4})[A-Za-z0-9_]+/g, "$1***")
    .replace(/\b(AKIA[0-9A-Z]{4})[0-9A-Z]{8,}/g, "$1***")
    .replace(/\b(xox[abprs]-[A-Za-z0-9]{3})[A-Za-z0-9-]+/g, "$1***")
    .replace(/(\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1***@")
    .trim()
    .slice(0, length);
}

function loadPrices(): PriceTable {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prices.json");
    return JSON.parse(fs.readFileSync(file, "utf8")) as PriceTable;
  } catch {
    return { cacheWriteMultiplier: 1.25, models: {} };
  }
}

export interface SessionSourceOptions {
  /** Project root whose sessions are shown. */
  root: string;
  /** Claude Code config directory (default: $CLAUDE_CONFIG_DIR or ~/.claude). */
  claudeHome?: string;
}

export function defaultClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function createSessionSource(opts: SessionSourceOptions) {
  const root = opts.root;
  const projectsRoot = path.join(opts.claudeHome ?? defaultClaudeHome(), "projects");
  const prices = loadPrices();

  function findPrice(model: string): Price | undefined {
    return prices.models[model] ?? prices.models[model.replace(/-\d{8}$/, "")];
  }
  /** API list-price equivalent in USD, or null when the model is missing from prices.json. */
  function computeUsd(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
    const p = findPrice(model);
    if (!p) return null;
    return (u.input * p.input + u.cacheWrite * p.input * prices.cacheWriteMultiplier + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
  }

  /** Claude Code stores a project under a folder whose name is the path with every non-alphanumeric character turned into "-".
   *  The drive letter's case can differ, so the name is matched case-insensitively. */
  function projectFolder(): string | undefined {
    const name = root.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
    if (!fs.existsSync(projectsRoot)) return undefined;
    const found = fs.readdirSync(projectsRoot).find((d) => d.toLowerCase() === name);
    return found ? path.join(projectsRoot, found) : undefined;
  }

  const rootLower = root.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  const homeLower = os.homedir().replace(/\\/g, "/").toLowerCase();
  /** Paths inside the project are shown relative, paths inside the home folder with "~/", others unchanged. */
  function shortenPath(p: string): string {
    const plain = p.replace(/\\/g, "/");
    const lower = plain.toLowerCase();
    if (lower.startsWith(rootLower + "/")) return plain.slice(rootLower.length + 1);
    if (lower.startsWith(homeLower + "/")) return "~" + plain.slice(homeLower.length);
    return plain;
  }

  function classify(tool: string, input: Record<string, unknown>): { kind: string; summary: string; path?: string } {
    const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
    switch (tool) {
      case "Read": { const p = shortenPath(s("file_path")); return { kind: "read", summary: p, path: p }; }
      case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": {
        const p = shortenPath(s("file_path") || s("notebook_path"));
        return { kind: "write", summary: p, path: p };
      }
      case "Grep": case "Glob": return { kind: "search", summary: `${s("pattern")}${s("path") ? ` (${shortenPath(s("path"))})` : ""}`.slice(0, 160) };
      case "Bash": case "PowerShell": return { kind: "command", summary: redact(s("command")) };
      case "WebFetch": return { kind: "web", summary: redact(s("url")) };
      case "WebSearch": return { kind: "web", summary: s("query").slice(0, 160) };
      case "Agent": case "Task": return { kind: "agent", summary: `${s("subagent_type") || "general"}: ${s("description")}`.slice(0, 160) };
      case "Skill": return { kind: "skill", summary: s("skill") };
      default: return { kind: "other", summary: tool.startsWith("mcp__") ? tool.split("__").slice(1).join(" · ") : "" };
    }
  }

  interface Message { agent: string; model: string; time: string; usage: Record<string, number> }
  interface Transcript {
    events: SessionEvent[];
    messages: Map<string, Message>;
    toolOwner: Map<string, string>;
    errors: Map<string, string>;
    prompts: Array<{ time: string; text: string }>;
    first: string;
    last: string;
  }

  /** A user line is either a plain-text prompt or a tool result carrying an error. */
  function handleUserLine(o: { isMeta?: boolean; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } }, isMain: boolean, t: Transcript): void {
    const content = o.message?.content;
    if (Array.isArray(content)) {
      for (const c of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
        if (c.type === "tool_result" && c.is_error && c.tool_use_id) {
          const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? (c.content as Array<{ text?: string }>).map((x) => x.text ?? "").join(" ") : "";
          t.errors.set(c.tool_use_id, redact(text.replace(/<\/?[a-z_]+>/gi, " "), 200) || "error");
        }
      }
    }
    // Prompt: text typed by the user in the main session. System attachments, command output and tool results do not count.
    if (!isMain || o.isMeta || o.isSidechain || !o.timestamp) return;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content) && (content as Array<{ type?: string }>).every((c) => c.type === "text")) text = (content as Array<{ text?: string }>).map((c) => c.text ?? "").join(" ");
    text = text.trim();
    if (!text || text.startsWith("<") || text.startsWith("[SYSTEM") || text.startsWith("Caveat:")) return;
    t.prompts.push({ time: o.timestamp, text: redact(text, 90) });
  }

  /** Reads one transcript file line by line. Only assistant lines and user lines carrying errors or prompts are parsed. */
  async function readTranscript(file: string, defaultAgent: string, t: Transcript): Promise<void> {
    const isMain = defaultAgent === "main";
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.includes('"type":"user"')) {
        // Large tool results are not parsed: only lines with an error, or short lines that might be a prompt.
        if (!line.includes('"is_error":true') && !(isMain && line.length < 20000)) continue;
        let o: Parameters<typeof handleUserLine>[0] & { type?: string };
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === "user") handleUserLine(o, isMain, t);
        continue;
      }
      if (!line.includes('"type":"assistant"')) continue;
      let o: { type?: string; timestamp?: string; agentId?: string; message?: { id?: string; model?: string; usage?: Record<string, number>; content?: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }> } };
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "assistant" || !o.message) continue;
      const agent = o.agentId ?? defaultAgent;
      const time = o.timestamp ?? "";
      if (time) { if (!t.first || time < t.first) t.first = time; if (time > t.last) t.last = time; }
      // One response is split over several lines that all carry the same usage numbers: count once per message id.
      if (o.message.id && o.message.usage && o.message.model && o.message.model !== "<synthetic>" && !t.messages.has(o.message.id)) {
        t.messages.set(o.message.id, { agent, model: o.message.model, time, usage: o.message.usage });
      }
      for (const c of o.message.content ?? []) {
        if (c.type !== "tool_use" || !c.name) continue;
        if (c.id) t.toolOwner.set(c.id, agent);
        t.events.push({ time, agent, tool: c.name, id: c.id, ...classify(c.name, c.input ?? {}) });
      }
    }
  }

  const titleCache = new Map<string, { mtime: number; title: string; startedAt: string }>();
  function sessionTitle(file: string, st: fs.Stats): { title: string; startedAt: string } {
    const cached = titleCache.get(file);
    if (cached && cached.mtime === st.mtimeMs) return cached;
    const fd = fs.openSync(file, "r");
    let title = "";
    let startedAt = "";
    try {
      const head = Buffer.alloc(Math.min(st.size, 65536));
      fs.readSync(fd, head, 0, head.length, 0);
      startedAt = head.toString("utf8").match(/"timestamp":"([^"]+)"/)?.[1] ?? "";
      // The title line is short but can be anywhere in the file: search backwards in 1 MB chunks.
      const CHUNK = 1 << 20;
      for (let end = st.size; end > 0 && !title; end -= CHUNK) {
        const begin = Math.max(0, end - CHUNK - 4096);
        const buf = Buffer.alloc(end - begin);
        fs.readSync(fd, buf, 0, buf.length, begin);
        const matches = [...buf.toString("utf8").matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)];
        const last = matches[matches.length - 1];
        if (last) { try { title = JSON.parse(`"${last[1]}"`) as string; } catch { /* partial line */ } }
      }
    } finally {
      fs.closeSync(fd);
    }
    const result = { mtime: st.mtimeMs, title, startedAt };
    titleCache.set(file, result);
    return result;
  }

  function subagentFiles(folder: string, id: string): string[] {
    const d = path.join(folder, id, "subagents");
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => /^agent-.+\.jsonl$/.test(f)).map((f) => path.join(d, f));
  }

  function list() {
    const folder = projectFolder();
    if (!folder) return { project: path.basename(root), found: false, sessions: [] };
    const sessions = fs
      .readdirSync(folder)
      .filter((f) => f.endsWith(".jsonl") && SESSION_ID.test(f.replace(/\.jsonl$/, "")))
      .map((f) => ({ id: f.replace(/\.jsonl$/, ""), file: path.join(folder, f), st: fs.statSync(path.join(folder, f)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 40)
      .map((o) => {
        const b = sessionTitle(o.file, o.st);
        return {
          id: o.id,
          title: b.title || o.id.slice(0, 8),
          startedAt: b.startedAt || null,
          endedAt: o.st.mtime.toISOString(),
          bytes: o.st.size,
          subagentCount: subagentFiles(folder, o.id).length,
          live: Date.now() - o.st.mtimeMs < 90_000,
        };
      });
    return { project: path.basename(root), found: true, sessions };
  }

  const cache = new Map<string, { signature: string; value: unknown }>();

  async function session(id: string) {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    const folder = projectFolder();
    const mainFile = folder ? path.join(folder, `${id}.jsonl`) : "";
    if (!folder || !fs.existsSync(mainFile)) throw new Error(`Session not found: ${id}`);
    const subFiles = subagentFiles(folder, id);
    const st = fs.statSync(mainFile);
    const signature = [mainFile, ...subFiles].map((f) => `${fs.statSync(f).size}`).join(",");
    const hit = cache.get(id);
    if (hit && hit.signature === signature) return { ...(hit.value as object), live: Date.now() - st.mtimeMs < 90_000 };

    const t: Transcript = { events: [], messages: new Map(), toolOwner: new Map(), errors: new Map(), prompts: [], first: "", last: "" };
    await readTranscript(mainFile, "main", t);
    const metas = new Map<string, SubagentMeta>();
    for (const f of subFiles) {
      const agentId = path.basename(f).replace(/^agent-/, "").replace(/\.jsonl$/, "");
      await readTranscript(f, agentId, t);
      try { metas.set(agentId, JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, ".meta.json"), "utf8")) as SubagentMeta); } catch { metas.set(agentId, {}); }
    }
    t.events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    for (const o of t.events) if (o.id && t.errors.has(o.id)) o.error = t.errors.get(o.id);

    // ---- Errors and retries: the same agent re-ran the failed tool with the same input within the next 15 events.
    const eventsByAgent = new Map<string, SessionEvent[]>();
    for (const o of t.events) { const l = eventsByAgent.get(o.agent) ?? []; l.push(o); eventsByAgent.set(o.agent, l); }
    const retries: Array<{ agent: string; tool: string; summary: string; attempts: number; outcome: "success" | "error"; first: string; last: string; error: string }> = [];
    for (const [agent, l] of eventsByAgent) {
      const handled = new Set<number>();
      for (let i = 0; i < l.length; i++) {
        const o = l[i]!;
        if (!o.error || handled.has(i) || !o.summary) continue;
        let attempts = 1, lastIndex = i;
        for (let j = i + 1; j < l.length && j <= lastIndex + 15; j++) {
          const x = l[j]!;
          if (x.tool === o.tool && x.summary === o.summary) { attempts++; lastIndex = j; handled.add(j); if (!x.error) break; }
        }
        if (attempts > 1) {
          const last = l[lastIndex]!;
          retries.push({ agent, tool: o.tool, summary: o.summary, attempts, outcome: last.error ? "error" : "success", first: o.time, last: last.time, error: o.error });
        }
      }
    }

    // ---- Model and tokens per agent, with the API list-price equivalent.
    const agentIds = new Set<string>(["main", ...metas.keys(), ...t.events.map((o) => o.agent)]);
    const usage = new Map<string, Map<string, Usage>>();
    const unpriced = new Set<string>();
    const ordered = [...t.messages.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
    const t0 = Date.parse(t.first || ordered[0]?.time || "") || 0;
    const spend: Array<[number, string, string, number, number]> = []; // [ms, agent, model, usd, output tokens]
    for (const m of ordered) {
      const perModel = usage.get(m.agent) ?? new Map<string, Usage>();
      const u = perModel.get(m.model) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const cur = { input: m.usage.input_tokens ?? 0, output: m.usage.output_tokens ?? 0, cacheRead: m.usage.cache_read_input_tokens ?? 0, cacheWrite: m.usage.cache_creation_input_tokens ?? 0 };
      u.calls++;
      u.input += cur.input;
      u.output += cur.output;
      u.cacheRead += cur.cacheRead;
      u.cacheWrite += cur.cacheWrite;
      perModel.set(m.model, u);
      usage.set(m.agent, perModel);
      const usd = computeUsd(m.model, cur);
      if (usd === null) unpriced.add(m.model);
      spend.push([Math.max(0, (Date.parse(m.time) || t0) - t0), m.agent, m.model, Math.round((usd ?? 0) * 1e6) / 1e6, cur.output]);
    }

    // ---- File heat. Redundant read = the same agent re-reads a file nobody wrote in between.
    const heat = new Map<string, { path: string; reads: number; writes: number; redundantReads: number; errors: number; agents: Set<string>; first: string; last: string }>();
    const lastReadVersion = new Map<string, number>(); // "agent|path" → version at last read
    const version = new Map<string, number>(); // path → number of writes so far
    for (const o of t.events) {
      if (!o.path || (o.kind !== "read" && o.kind !== "write")) continue;
      const f = heat.get(o.path) ?? { path: o.path, reads: 0, writes: 0, redundantReads: 0, errors: 0, agents: new Set<string>(), first: o.time, last: o.time };
      f.agents.add(o.agent);
      f.last = o.time;
      if (o.error) f.errors++;
      if (o.kind === "write") { f.writes++; version.set(o.path, (version.get(o.path) ?? 0) + 1); }
      else {
        f.reads++;
        const key = `${o.agent}|${o.path}`;
        const v = version.get(o.path) ?? 0;
        if (lastReadVersion.get(key) === v && !o.error) f.redundantReads++;
        if (!o.error) lastReadVersion.set(key, v);
      }
      heat.set(o.path, f);
    }
    const fileHeat = [...heat.values()]
      .sort((a, b) => b.reads + b.writes - (a.reads + a.writes) || a.path.localeCompare(b.path))
      .slice(0, 200)
      .map((f) => ({ ...f, agents: [...f.agents] }));

    const agents = [...agentIds].map((agentId) => {
      const meta = metas.get(agentId);
      const events = eventsByAgent.get(agentId) ?? [];
      const files = new Map<string, { path: string; reads: number; writes: number }>();
      for (const o of events) {
        if (!o.path || (o.kind !== "read" && o.kind !== "write")) continue;
        const f = files.get(o.path) ?? { path: o.path, reads: 0, writes: 0 };
        if (o.kind === "read") f.reads++; else f.writes++;
        files.set(o.path, f);
      }
      const sortedFiles = [...files.values()].sort((a, b) => b.writes - a.writes || b.reads - a.reads || a.path.localeCompare(b.path));
      const count = (kind: string) => events.filter((o) => o.kind === kind).length;
      const models = [...(usage.get(agentId) ?? new Map<string, Usage>()).entries()]
        .map(([model, u]) => ({ model, ...u, usd: computeUsd(model, u) }))
        .sort((a, b) => b.output - a.output);
      return {
        id: agentId,
        name: agentId === "main" ? "Main session" : (meta?.agentType ?? "subagent"),
        description: meta?.description ?? "",
        parent: agentId === "main" ? null : ((meta?.toolUseId && t.toolOwner.get(meta.toolUseId)) || "main"),
        requestedModel: meta?.model ?? null,
        effort: meta?.effort ?? null,
        finished: agentId === "main" ? null : meta?.finished === true,
        models,
        usd: models.reduce((s, m) => s + (m.usd ?? 0), 0),
        counts: { tools: events.length, read: count("read"), write: count("write"), command: count("command"), web: count("web"), search: count("search"), agent: count("agent"), errors: events.filter((o) => o.error).length },
        first: events[0]?.time ?? null,
        last: events[events.length - 1]?.time ?? null,
        fileCount: sortedFiles.length,
        files: sortedFiles.slice(0, 80),
        events: events.slice(-400).map((o) => ({ time: o.time, tool: o.tool, kind: o.kind, summary: o.summary, error: o.error ?? null })),
      };
    });
    agents.sort((a, b) => (a.id === "main" ? -1 : b.id === "main" ? 1 : (a.first ?? "").localeCompare(b.first ?? "")));

    // ---- Handoffs: a file written by one agent and later read by another has carried data between them.
    const lastWriter = new Map<string, string>();
    const handoffs: Array<{ path: string; writer: string; reader: string; time: string }> = [];
    const seen = new Set<string>();
    for (const o of t.events) {
      if (!o.path || o.error) continue;
      if (o.kind === "write") lastWriter.set(o.path, o.agent);
      else if (o.kind === "read") {
        const writer = lastWriter.get(o.path);
        const key = `${o.path}|${writer}|${o.agent}`;
        if (writer && writer !== o.agent && !seen.has(key)) {
          seen.add(key);
          handoffs.push({ path: o.path, writer, reader: o.agent, time: o.time });
        }
      }
    }

    // ---- Replay timeline: ms since the start, agent, kind, tool, summary, path, error.
    const fullTimeline = t.events.map((o) => ({ t: Math.max(0, (Date.parse(o.time) || t0) - t0), agent: o.agent, kind: o.kind, tool: o.tool, summary: o.summary, path: o.path ?? null, error: o.error ?? null }));
    // A very long session is thinned out at regular intervals; errors, writes and subagent launches always stay.
    let timeline = fullTimeline;
    if (fullTimeline.length > REPLAY_LIMIT) {
      const step = fullTimeline.length / REPLAY_LIMIT;
      timeline = fullTimeline.filter((o, i) => o.error || o.kind === "write" || o.kind === "agent" || Math.floor(i / step) !== Math.floor((i - 1) / step));
    }
    const prompts = t.prompts
      .sort((a, b) => (a.time < b.time ? -1 : 1))
      .map((p) => ({ t: Math.max(0, (Date.parse(p.time) || t0) - t0), time: p.time, text: p.text }));

    const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, errors: 0, retries: retries.length, redundantReads: 0 };
    for (const a of agents) for (const m of a.models) { totals.calls += m.calls; totals.input += m.input; totals.output += m.output; totals.cacheRead += m.cacheRead; totals.cacheWrite += m.cacheWrite; totals.usd += m.usd ?? 0; }
    totals.errors = t.events.filter((o) => o.error).length;
    totals.redundantReads = fileHeat.reduce((s, f) => s + f.redundantReads, 0);
    totals.usd = Math.round(totals.usd * 1e4) / 1e4;

    const title = sessionTitle(mainFile, st);
    const value = {
      id,
      title: title.title || id.slice(0, 8),
      startedAt: t.first || title.startedAt || null,
      endedAt: t.last || st.mtime.toISOString(),
      durationMs: Math.max(0, (Date.parse(t.last) || t0) - t0),
      agents,
      handoffs,
      totals,
      pricing: { source: prices.source ?? null, unpriced: [...unpriced], note: "API list-price equivalent; subscription usage is not billed per token" },
      fileHeat,
      errors: t.events.filter((o) => o.error).slice(-300).map((o) => ({ time: o.time, agent: o.agent, tool: o.tool, summary: o.summary, error: o.error })),
      retries: retries.slice(-200),
      replay: { events: timeline, truncated: fullTimeline.length > timeline.length ? fullTimeline.length : 0, spend, prompts },
    };
    cache.set(id, { signature, value });
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
    return { ...value, live: Date.now() - st.mtimeMs < 90_000 };
  }

  return { list, session };
}
