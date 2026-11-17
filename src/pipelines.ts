// Pipeline source: reads pipelines/*.yaml, agents/*.md, an optional models config and the runs/ folder.
// It writes exactly two things: the switch file (<state>/switches.json) and the model lines in an agent file.
// It imports nothing from your orchestrator and loads no .env. See README.md for the YAML formats.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const NAME = /^[A-Za-z0-9_-]+$/;
const RUN_ID = /^(\d{8}-\d{6})-([A-Za-z0-9_-]+)$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface RawStep { id: string; agent?: string; tool?: string; description?: string; optional?: boolean; inputs?: Record<string, unknown>; review?: unknown }
interface RawPipeline { name?: string; description?: string; inputs?: Record<string, { description?: string }>; steps?: RawStep[] }
interface RawAgent { name?: string; role?: string; model?: { tier?: string; primary?: string; fallbacks?: string[] }; reads?: string[]; output?: { files?: Array<{ name: string }> } }
interface StepResult { status: string; order: number; model?: string; durationMs?: number; usd?: number; error?: string }
interface RunRecord { id: string; pipeline: string; status: string; steps: Record<string, StepResult>; createdAt: string; updatedAt: string; totalUsd: number; note?: string }
export interface Switches { pipelines?: Record<string, boolean>; steps?: Record<string, Record<string, boolean>> }

/** Model family, used to warn when a review step runs on the same family as the steps it reviews. */
function modelFamily(full: string): string {
  const model = full.includes("/") ? full.split("/").slice(1).join("/") : full;
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gemini") || model.startsWith("gemma")) return "google";
  if (/^(gpt|o\d|chatgpt)/.test(model) || model.includes("gpt-oss")) return "openai";
  if (model.startsWith("llama")) return "meta";
  if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
  return model.split(/[-/]/)[0] ?? model;
}

export interface PipelineSourceOptions {
  root: string;
  pipelinesDir: string;
  agentsDir: string;
  runsDir: string;
  /** Optional YAML file with `tiers:` and `providers:` (see README). */
  modelsFile: string;
  /** Folder for the switch file and the change log. */
  stateDir: string;
}

export function createPipelineSource(opts: PipelineSourceOptions) {
  const { root } = opts;
  const switchFile = path.join(opts.stateDir, "switches.json");
  const changeLog = path.join(opts.stateDir, "changes.jsonl");

  // File cache: a file is parsed again only when its modification time changes.
  const cache = new Map<string, { mtime: number; value: unknown }>();
  function cached<T>(file: string, parse: (text: string) => T): T {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.value as T;
    const value = parse(fs.readFileSync(file, "utf8"));
    cache.set(file, { mtime, value });
    return value;
  }
  const relative = (f: string) => path.relative(root, f).replace(/\\/g, "/");

  function pipelineNames(): string[] {
    if (!fs.existsSync(opts.pipelinesDir)) return [];
    return fs.readdirSync(opts.pipelinesDir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith("_")).map((f) => f.replace(/\.ya?ml$/, "")).sort();
  }
  function pipelineFile(name: string): string {
    for (const ext of [".yaml", ".yml"]) {
      const f = path.join(opts.pipelinesDir, name + ext);
      if (fs.existsSync(f)) return f;
    }
    throw new Error(`Pipeline not found: ${name}`);
  }
  function readPipeline(name: string): RawPipeline {
    if (!NAME.test(name)) throw new Error(`Invalid pipeline name: ${name}`);
    return cached(pipelineFile(name), (m) => (YAML.parse(m) ?? {}) as RawPipeline);
  }

  function readAgent(name: string): RawAgent | undefined {
    if (!NAME.test(name)) return undefined;
    const file = path.join(opts.agentsDir, `${name}.md`);
    if (!fs.existsSync(file)) return undefined;
    return cached(file, (m) => (YAML.parse(m.match(FRONT_MATTER)?.[1] ?? "") ?? {}) as RawAgent);
  }

  function modelsConfig(): { tiers: Record<string, string[]>; providers: Record<string, { paid?: boolean }> } {
    if (!fs.existsSync(opts.modelsFile)) return { tiers: {}, providers: {} };
    return cached(opts.modelsFile, (m) => {
      const y = (YAML.parse(m) ?? {}) as Record<string, never>;
      return { tiers: y.tiers ?? {}, providers: y.providers ?? {} };
    });
  }
  const isPaid = (model: string) => modelsConfig().providers[model.split("/")[0] ?? ""]?.paid === true;

  function modelChain(agent: RawAgent | undefined): string[] {
    if (!agent?.model) return [];
    if (agent.model.tier) return modelsConfig().tiers[agent.model.tier] ?? [];
    return agent.model.primary ? [agent.model.primary, ...(agent.model.fallbacks ?? [])] : [];
  }

  function readSwitches(): Switches {
    try {
      return JSON.parse(fs.readFileSync(switchFile, "utf8")) as Switches;
    } catch {
      return {};
    }
  }

  /** Run ids, newest first. Id format: <YYYYMMDD>-<HHMMSS>-<pipeline>. */
  function runIds(pipeline?: string): string[] {
    if (!fs.existsSync(opts.runsDir)) return [];
    return fs
      .readdirSync(opts.runsDir)
      .filter((d) => {
        const m = d.match(RUN_ID);
        return m !== null && (pipeline === undefined || m[2] === pipeline);
      })
      .sort()
      .reverse();
  }
  function readRun(id: string): RunRecord | undefined {
    if (!RUN_ID.test(id)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(path.join(opts.runsDir, id, "run.json"), "utf8")) as RunRecord;
    } catch {
      return undefined; // folder exists but run.json is missing or being written right now
    }
  }
  function latestRuns(pipeline: string, count: number): RunRecord[] {
    const out: RunRecord[] = [];
    for (const id of runIds(pipeline)) {
      const run = readRun(id);
      if (run) out.push(run);
      if (out.length >= count) break;
    }
    return out;
  }
  const runSummary = (r: RunRecord) => ({ id: r.id, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, totalUsd: r.totalUsd, note: r.note ?? null });

  /** Which pipelines use each agent. */
  function agentUsage(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const name of pipelineNames()) {
      let p: RawPipeline;
      try { p = readPipeline(name); } catch { continue; }
      for (const s of p.steps ?? []) {
        if (!s.agent) continue;
        const l = m.get(s.agent) ?? [];
        if (!l.includes(name)) l.push(name);
        m.set(s.agent, l);
      }
    }
    return m;
  }

  function modelOptions(): string[] {
    const set = new Set<string>();
    for (const l of Object.values(modelsConfig().tiers)) for (const m of l) set.add(m);
    if (fs.existsSync(opts.agentsDir)) {
      for (const f of fs.readdirSync(opts.agentsDir)) {
        if (!f.endsWith(".md") || f.startsWith("_")) continue;
        const a = readAgent(f.replace(/\.md$/, ""));
        if (a?.model?.primary) for (const m of [a.model.primary, ...(a.model.fallbacks ?? [])]) set.add(m);
      }
    }
    return [...set].sort();
  }

  // ---------- Read endpoints ----------

  function list() {
    const sw = readSwitches();
    return pipelineNames().map((name) => {
      let p: RawPipeline = {};
      let error: string | undefined;
      try { p = readPipeline(name); } catch (e) { error = (e as Error).message; }
      const last = latestRuns(name, 1)[0];
      return {
        name,
        description: p.description ?? "",
        stepCount: p.steps?.length ?? 0,
        enabled: sw.pipelines?.[name] !== false,
        disabledSteps: Object.values(sw.steps?.[name] ?? {}).filter((v) => v === false).length,
        lastRun: last ? runSummary(last) : null,
        error: error ?? null,
      };
    });
  }

  function pipeline(name: string) {
    const p = readPipeline(name);
    const sw = readSwitches();
    const usage = agentUsage();
    const runs = latestRuns(name, 10);
    const rawSteps = p.steps ?? [];
    const ids = rawSteps.map((s) => s.id);
    const edges: Array<{ source: string; target: string; label: string; optional: boolean }> = [];

    const steps = rawSteps.map((s, i) => {
      const agent = s.agent ? readAgent(s.agent) : undefined;
      const chain = modelChain(agent);
      let dependsOnAllPrevious = false;
      const inputs = Object.entries(s.inputs ?? {}).map(([inputName, expr]) => {
        let source: string | null = null;
        let field: string | null = null;
        if (typeof expr === "string" && expr.startsWith("$")) {
          const [head, rest] = expr.slice(1).split(".", 2);
          field = rest ?? null;
          if (head === "input") source = "input";
          else if (head === "previous_steps") { source = "previous_steps"; dependsOnAllPrevious = true; }
          else if (head && ids.slice(0, i).includes(head)) source = head;
        }
        const sourceStep = rawSteps.find((x) => x.id === source);
        const optional = sourceStep?.optional === true;
        if (source && source !== "previous_steps") {
          const existing = edges.find((k) => k.source === source && k.target === s.id);
          const label = String(expr).slice(1);
          if (existing) existing.label += `, ${label}`;
          else edges.push({ source, target: s.id, label, optional });
        }
        return { name: inputName, expr: typeof expr === "string" ? expr : JSON.stringify(expr), source, field, optional };
      });

      const history = runs
        .filter((r) => r.steps?.[s.id])
        .slice(0, 8)
        .map((r) => {
          const k = r.steps[s.id]!;
          return { run: r.id, time: r.createdAt, status: k.status, model: k.model ?? null, durationMs: k.durationMs ?? null, usd: k.usd ?? null };
        });
      const done = history.filter((g) => g.status === "done" && g.durationMs !== null);
      const avg = (f: (g: (typeof done)[number]) => number) => (done.length ? done.reduce((t, g) => t + f(g), 0) / done.length : null);

      return {
        id: s.id,
        order: i + 1,
        kind: s.agent ? "agent" : "tool",
        executor: s.agent ?? s.tool ?? "?",
        description: agent?.role ?? s.description ?? "",
        definitionFile: s.agent ? relative(path.join(opts.agentsDir, `${s.agent}.md`)) : null,
        optional: s.optional === true,
        review: s.review !== undefined && s.review !== false,
        enabled: sw.steps?.[name]?.[s.id] !== false,
        model: s.agent ? { tier: agent?.model?.tier ?? null, chain, paid: chain.filter(isPaid) } : null,
        usedByPipelines: s.agent ? (usage.get(s.agent) ?? []) : [],
        reads: agent?.reads ?? [],
        produces: ["output.json", ...(agent?.output?.files ?? []).map((d) => d.name)],
        inputs,
        dependsOnAllPrevious,
        history,
        stats: { runs: done.length, avgDurationMs: avg((g) => g.durationMs ?? 0), avgUsd: avg((g) => g.usd ?? 0) },
        error: s.agent && !agent ? `${relative(path.join(opts.agentsDir, `${s.agent}.md`))} not found` : null,
      };
    });

    // Reviewer independence: a review step's primary model should not be from the same family as the steps before it.
    const warnings: string[] = [];
    for (const r of steps.filter((x) => x.review && x.model?.chain[0])) {
      const family = modelFamily(r.model!.chain[0]!);
      const same = steps.filter((x) => x.id !== r.id && x.order < r.order && x.model?.chain[0] && modelFamily(x.model.chain[0]) === family).map((x) => x.id);
      if (same.length) warnings.push(`Review step '${r.id}' (${r.model!.chain[0]}) uses the same model family as: ${same.join(", ")}`);
    }

    return {
      name,
      description: p.description ?? "",
      file: relative(pipelineFile(name)),
      enabled: sw.pipelines?.[name] !== false,
      inputs: Object.entries(p.inputs ?? {}).map(([n, d]) => ({ name: n, description: d?.description ?? "" })),
      steps,
      edges,
      models: modelOptions().map((m) => ({ name: m, paid: isPaid(m) })),
      tiers: modelsConfig().tiers,
      runs: runs.map(runSummary),
      warnings,
    };
  }

  function run(id: string) {
    const record = readRun(id);
    if (!record) throw new Error(`Run not found: ${id}`);
    let definition: RawPipeline = {};
    try { definition = readPipeline(record.pipeline); } catch { /* the pipeline may have been deleted */ }
    const steps: Record<string, unknown> = {};
    for (const [stepId, k] of Object.entries(record.steps)) {
      const folder = path.join(opts.runsDir, id, "steps", `${String(k.order + 1).padStart(2, "0")}-${stepId}`);
      let files: Array<{ name: string; bytes: number }> = [];
      let actualModel: string | null = null;
      try {
        files = fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isFile()).slice(0, 40).map((d) => ({ name: d.name, bytes: fs.statSync(path.join(folder, d.name)).size }));
        const meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")) as { actualModel?: string };
        actualModel = meta.actualModel ?? null;
      } catch { /* the step has not created its folder or meta yet */ }
      // Fallback: the model that ran the step is not the agent's current primary model.
      const agentName = definition.steps?.find((a) => a.id === stepId)?.agent;
      const primary = agentName ? modelChain(readAgent(agentName))[0] : undefined;
      steps[stepId] = {
        status: k.status,
        model: k.model ?? null,
        actualModel,
        durationMs: k.durationMs ?? null,
        usd: k.usd ?? null,
        error: k.error ?? null,
        folder: relative(folder),
        files,
        fellBack: Boolean(primary && k.model && !k.model.startsWith("tool/") && k.model !== primary),
      };
    }
    return { ...runSummary(record), pipeline: record.pipeline, steps };
  }

  // ---------- Write endpoints ----------

  function logChange(entry: Record<string, unknown>): void {
    fs.mkdirSync(opts.stateDir, { recursive: true });
    fs.appendFileSync(changeLog, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", "utf8");
  }

  /** Turns a pipeline or a step on or off. Only disabled entries are stored. */
  function setSwitch(g: { pipeline: string; step?: string; enabled: boolean }) {
    const p = readPipeline(g.pipeline);
    if (g.step !== undefined && !(p.steps ?? []).some((s) => s.id === g.step)) throw new Error(`Pipeline '${g.pipeline}' has no step '${g.step}'`);
    const sw = readSwitches();
    sw.pipelines ??= {};
    sw.steps ??= {};
    if (g.step === undefined) {
      if (g.enabled) delete sw.pipelines[g.pipeline]; else sw.pipelines[g.pipeline] = false;
    } else {
      const b = (sw.steps[g.pipeline] ??= {});
      if (g.enabled) delete b[g.step]; else b[g.step] = false;
      if (!Object.keys(b).length) delete sw.steps[g.pipeline];
    }
    fs.mkdirSync(opts.stateDir, { recursive: true });
    fs.writeFileSync(switchFile + ".tmp", JSON.stringify(sw, null, 2), "utf8");
    fs.renameSync(switchFile + ".tmp", switchFile);
    logChange({ type: "switch", pipeline: g.pipeline, step: g.step ?? null, enabled: g.enabled });
    return { ok: true, enabled: g.enabled };
  }

  /** Changes an agent's primary model (or tier). Only that line changes; comments and other lines are kept.
   *  If the new model is among the fallbacks it swaps places with the old primary. The file is parsed again after writing and restored if broken. */
  function setModel(g: { agent: string; model?: string; tier?: string }) {
    if (!NAME.test(g.agent)) throw new Error(`Invalid agent name: ${g.agent}`);
    const file = path.join(opts.agentsDir, `${g.agent}.md`);
    if (!fs.existsSync(file)) throw new Error(`Agent not found: ${g.agent}`);
    const original = fs.readFileSync(file, "utf8");
    if (!original.match(FRONT_MATTER)) throw new Error(`${g.agent}: YAML front matter not found`);
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.split(/\r?\n/);
    const frontEnd = lines.indexOf("---", 1);
    const modelLine = lines.findIndex((s, i) => i < frontEnd && /^model:\s*(#.*)?$/.test(s));
    if (modelLine < 0) throw new Error(`${g.agent}: no 'model:' block found`);
    let blockEnd = modelLine + 1;
    while (blockEnd < frontEnd && /^(\s+|\s*#|\s*$)/.test(lines[blockEnd] ?? "")) blockEnd++;
    const find = (re: RegExp) => {
      for (let i = modelLine + 1; i < blockEnd; i++) if (re.test(lines[i] ?? "")) return i;
      return -1;
    };
    let from: string;
    let to: string;

    if (g.tier !== undefined) {
      if (!modelsConfig().tiers[g.tier]) throw new Error(`Unknown tier: ${g.tier}`);
      const i = find(/^\s+tier:\s*\S+/);
      if (i < 0) throw new Error(`${g.agent} does not use a tier; choose a model instead`);
      const m = (lines[i] ?? "").match(/^(\s+tier:\s*)(\S+)(.*)$/)!;
      from = m[2]!;
      to = g.tier;
      lines[i] = `${m[1]}${g.tier}${m[3]}`;
    } else if (g.model !== undefined) {
      if (!modelOptions().includes(g.model)) throw new Error(`Unknown model: ${g.model}`);
      const i = find(/^\s+primary:\s*\S+/);
      if (i < 0) throw new Error(`${g.agent} uses a tier; choose a tier instead`);
      const m = (lines[i] ?? "").match(/^(\s+primary:\s*)(\S+)(.*)$/)!;
      from = m[2]!;
      to = g.model;
      if (from === to) return { ok: true, chain: modelChain(readAgent(g.agent)) };
      lines[i] = `${m[1]}${to}${m[3]}`;
      for (let j = modelLine + 1; j < blockEnd; j++) {
        const y = (lines[j] ?? "").match(/^(\s+-\s*)(\S+)(.*)$/);
        if (y && y[2] === to) { lines[j] = `${y[1]}${from}${y[3]}`; break; }
      }
    } else {
      throw new Error("model or tier is required");
    }

    fs.writeFileSync(file + ".tmp", lines.join(eol), "utf8");
    fs.renameSync(file + ".tmp", file);
    try {
      const parsed = (YAML.parse(fs.readFileSync(file, "utf8").match(FRONT_MATTER)?.[1] ?? "") ?? {}) as RawAgent;
      const ok = g.tier !== undefined ? parsed.model?.tier === g.tier : parsed.model?.primary === g.model;
      if (!ok) throw new Error("written value could not be read back");
    } catch (e) {
      fs.writeFileSync(file, original, "utf8");
      throw new Error(`${g.agent}: change rolled back (${(e as Error).message})`);
    }
    logChange({ type: "model", agent: g.agent, from, to });
    return { ok: true, from, to, chain: modelChain(readAgent(g.agent)) };
  }

  return { list, pipeline, run, setSwitch, setModel, names: pipelineNames };
}
