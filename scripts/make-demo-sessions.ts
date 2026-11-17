// Writes made-up Claude Code session transcripts for the demo project, so the board can be tried (and screenshotted)
// without any real data. Everything here is invented: a small "tidy-notes" CLI, three sessions, two subagents.
//   node scripts/make-demo-sessions.ts <claude-home> <project-root>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function rng(seed: number) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Line = Record<string, unknown>;

class Writer {
  lines: Line[] = [];
  root: string;
  agentId?: string;
  t: number;
  counter = 0;
  rand: () => number;
  constructor(root: string, start: number, seed: number, agentId?: string) {
    this.root = root;
    this.agentId = agentId;
    this.t = start;
    this.rand = rng(seed);
  }
  iso() { return new Date(this.t).toISOString(); }
  advance(minSec: number, maxSec: number) { this.t += Math.round((minSec + this.rand() * (maxSec - minSec)) * 1000); }
  id(prefix: string) { this.counter++; return `${prefix}_${(this.agentId ?? "main").slice(0, 6)}${String(this.counter).padStart(5, "0")}${Math.floor(this.rand() * 1e6).toString(36)}`; }
  file(rel: string) { return path.join(this.root, ...rel.split("/")); }
  prompt(text: string) {
    this.lines.push({ type: "user", timestamp: this.iso(), isSidechain: false, message: { role: "user", content: text } });
  }
  /** One assistant message with one tool call, optionally followed by an error result. Returns the tool_use id. */
  call(model: string, tool: string, input: Record<string, unknown>, opts: { error?: string; text?: string; out?: number; cacheRead?: number; cacheWrite?: number; wait?: [number, number] } = {}): string {
    this.advance(...(opts.wait ?? [4, 28]));
    const toolId = this.id("toolu");
    const content: unknown[] = [];
    if (opts.text) content.push({ type: "text", text: opts.text });
    content.push({ type: "tool_use", id: toolId, name: tool, input });
    this.lines.push({
      type: "assistant", timestamp: this.iso(), ...(this.agentId ? { agentId: this.agentId, isSidechain: true } : {}),
      message: { id: this.id("msg"), model, role: "assistant", content, usage: this.usage(opts) },
    });
    if (opts.error) {
      this.advance(1, 4);
      this.lines.push({ type: "user", timestamp: this.iso(), ...(this.agentId ? { agentId: this.agentId, isSidechain: true } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, is_error: true, content: opts.error }] } });
    }
    return toolId;
  }
  say(model: string, text: string, opts: { out?: number } = {}) {
    this.advance(3, 12);
    this.lines.push({ type: "assistant", timestamp: this.iso(), ...(this.agentId ? { agentId: this.agentId, isSidechain: true } : {}), message: { id: this.id("msg"), model, role: "assistant", content: [{ type: "text", text }], usage: this.usage(opts) } });
  }
  usage(o: { out?: number; cacheRead?: number; cacheWrite?: number }) {
    const grow = Math.min(1, this.counter / 40);
    return {
      input_tokens: 3 + Math.floor(this.rand() * 9),
      output_tokens: o.out ?? 90 + Math.floor(this.rand() * 520),
      cache_read_input_tokens: o.cacheRead ?? Math.round(18000 + grow * 52000 + this.rand() * 4000),
      cache_creation_input_tokens: o.cacheWrite ?? (this.rand() < 0.3 ? 700 + Math.floor(this.rand() * 3600) : 120 + Math.floor(this.rand() * 300)),
    };
  }
}

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const jsonl = (lines: Line[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function sessionOne(root: string, home: string, folder: string, now: number) {
  const id = "5d2c9e4a-7b1f-4c36-9a58-3e1d6f0b2a47";
  const w = new Writer(root, now - 3.4 * 3600e3, 11);
  w.lines.push({ type: "ai-title", aiTitle: "Add a --json flag to the tidy-notes CLI", sessionId: id });
  w.prompt("Add a --json flag to the list command so it prints machine-readable output instead of the pretty table.");
  w.call(OPUS, "Glob", { pattern: "src/**/*.ts" }, { text: "I'll start by looking at how the CLI is structured." });
  w.call(OPUS, "Read", { file_path: w.file("src/cli.ts") });
  w.call(OPUS, "Read", { file_path: w.file("src/commands/list.ts") });
  w.call(OPUS, "Read", { file_path: w.file("src/format.ts") });
  w.call(OPUS, "Grep", { pattern: "console.log", path: w.file("src") });
  // subagent: code reviewer
  const reviewerId = "a3f9c1d2e4b5a7c8";
  const reviewerCall = w.call(OPUS, "Agent", { subagent_type: "code-reviewer", description: "Review the list command for output assumptions", prompt: "Check src/commands/list.ts and src/format.ts for places that assume a table on stdout." }, { text: "A second pair of eyes on the output code before I change it.", out: 420 });
  const r = new Writer(root, w.t + 3000, 23, reviewerId);
  r.call(SONNET, "Read", { file_path: r.file("src/commands/list.ts") });
  r.call(SONNET, "Read", { file_path: r.file("src/format.ts") });
  r.call(SONNET, "Grep", { pattern: "process.stdout", path: r.file("src") });
  r.call(SONNET, "Read", { file_path: r.file("tests/list.test.ts") });
  r.call(SONNET, "Write", { file_path: r.file("reports/review.md"), content: "# Review\n..." }, { out: 900 });
  r.say(SONNET, "Review written to reports/review.md.", { out: 140 });
  w.t = Math.max(w.t, r.t) + 5000;
  w.call(OPUS, "Read", { file_path: w.file("reports/review.md") });
  w.call(OPUS, "Read", { file_path: w.file("src/cli.ts") }, { text: "Re-checking how flags are registered." });
  w.call(SONNET, "Edit", { file_path: w.file("src/format.ts"), old_string: "export function format", new_string: "export function formatJson" }, { out: 380 });
  w.call(SONNET, "Edit", { file_path: w.file("src/commands/list.ts"), old_string: "printTable(notes)", new_string: "print(notes, opts)" }, { error: "String to replace not found in file.\nString: printTable(notes)", out: 300 });
  w.call(SONNET, "Read", { file_path: w.file("src/commands/list.ts") });
  w.call(SONNET, "Edit", { file_path: w.file("src/commands/list.ts"), old_string: "printTable(notes, opts)", new_string: "print(notes, opts)" }, { out: 410 });
  w.call(SONNET, "Edit", { file_path: w.file("src/cli.ts"), old_string: ".option(\"--limit <n>\")", new_string: ".option(\"--limit <n>\")\n  .option(\"--json\")" }, { out: 330 });
  w.call(SONNET, "Bash", { command: "npm test -- --silent" }, { error: "FAIL tests/list.test.ts\n  list --json\n    expected output to be valid JSON\nTests: 1 failed, 14 passed", wait: [15, 40] });
  w.call(SONNET, "Read", { file_path: w.file("tests/list.test.ts") });
  w.call(SONNET, "Edit", { file_path: w.file("tests/list.test.ts"), old_string: "it(\"prints a table\"", new_string: "it(\"prints JSON with --json\"" }, { out: 520 });
  w.call(SONNET, "Bash", { command: "npm test -- --silent" }, { wait: [15, 40] });
  w.call(SONNET, "Edit", { file_path: w.file("README.md"), old_string: "## Usage", new_string: "## Usage\n\nUse `--json` for machine-readable output." }, { out: 260 });
  w.say(SONNET, "The list command now supports --json. Tests pass.", { out: 190 });

  w.t += 11 * 60e3;
  w.prompt("Nice. Can you also fix the heading bug in the parser that the review mentioned?");
  w.call(OPUS, "Read", { file_path: w.file("src/parser.ts") }, { text: "Let me look at the parser." });
  w.call(OPUS, "Read", { file_path: w.file("src/parser.ts") });
  w.call(OPUS, "Grep", { pattern: "heading", path: w.file("src") });
  w.call(SONNET, "Edit", { file_path: w.file("src/parser.ts"), old_string: "level = match[1].length", new_string: "level = Math.min(6, match[1].length)" }, { out: 450 });
  w.call(SONNET, "Write", { file_path: w.file("tests/parser-heading.test.ts"), content: "import { parse } from '../src/parser';" }, { out: 760 });
  w.call(SONNET, "Bash", { command: "npm test -- --silent" }, { error: "FAIL tests/parser-heading.test.ts\n  Cannot find module '../src/parser'", wait: [15, 40] });
  w.call(SONNET, "Edit", { file_path: w.file("tests/parser-heading.test.ts"), old_string: "'../src/parser'", new_string: "'../src/parser.ts'" }, { out: 240 });
  w.call(SONNET, "Bash", { command: "npm test -- --silent" }, { wait: [15, 40] });
  w.call(SONNET, "Bash", { command: "API_TOKEN=demo-token-123 npm run sync -- --dry-run" }, { wait: [6, 18] });
  w.call(SONNET, "Bash", { command: "git diff --stat" });
  w.say(SONNET, "Heading levels are now capped at 6 and covered by a test.", { out: 170 });

  w.t += 13 * 60e3;
  w.prompt("Run the whole suite plus lint and the type check, then summarize what still fails.");
  const runnerId = "b7e2d4f6a8c0e1d3";
  const runnerCall = w.call(OPUS, "Agent", { subagent_type: "test-runner", description: "Run tests, lint and type check and write a summary", prompt: "Run npm test, npm run lint and tsc --noEmit. Summarize failures in reports/test-run.md." }, { text: "Delegating the slow checks.", out: 350 });
  const x = new Writer(root, w.t + 2500, 37, runnerId);
  x.call(HAIKU, "Bash", { command: "npm run lint" }, { wait: [10, 25] });
  x.call(HAIKU, "Bash", { command: "npm test" }, { wait: [15, 45] });
  x.call(HAIKU, "Bash", { command: "npx tsc --noEmit" }, { error: "src/format.ts(41,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.", wait: [12, 30] });
  x.call(HAIKU, "Bash", { command: "npx tsc --noEmit" }, { error: "src/format.ts(41,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.", wait: [8, 20] });
  x.call(HAIKU, "Read", { file_path: x.file("src/format.ts") });
  x.call(HAIKU, "Write", { file_path: x.file("reports/test-run.md"), content: "# Test run\n..." }, { out: 640 });
  x.say(HAIKU, "Summary written to reports/test-run.md: lint and tests pass, one type error in src/format.ts.", { out: 120 });
  w.t = Math.max(w.t, x.t) + 4000;
  w.call(OPUS, "Read", { file_path: w.file("reports/test-run.md") });
  w.call(SONNET, "Read", { file_path: w.file("src/format.ts") });
  w.call(SONNET, "Edit", { file_path: w.file("src/format.ts"), old_string: "const label = notes[0]?.title", new_string: "const label = notes[0]?.title ?? \"\"" }, { out: 280 });
  w.call(SONNET, "Bash", { command: "npx tsc --noEmit" }, { wait: [8, 20] });
  w.say(OPUS, "Everything is green now: lint, 17 tests and the type check.", { out: 210 });

  write(home, folder, id, w.lines, [{ id: reviewerId, w: r, meta: { agentType: "code-reviewer", description: "Review the list command for output assumptions", toolUseId: reviewerCall, model: "sonnet", effort: "medium", finished: true } },
    { id: runnerId, w: x, meta: { agentType: "test-runner", description: "Run tests, lint and type check and write a summary", toolUseId: runnerCall, model: "haiku", effort: "low", finished: true } }], w);
}

function sessionTwo(root: string, home: string, folder: string, now: number) {
  const id = "c81b3f60-2d9a-4e7c-b514-0a6e92d7f3c1";
  const w = new Writer(root, now - 27 * 3600e3, 71);
  w.lines.push({ type: "ai-title", aiTitle: "Explain the sync module and add a retry", sessionId: id });
  w.prompt("Explain how the sync module talks to the server and add a retry with backoff.");
  w.call(OPUS, "Read", { file_path: w.file("src/sync.ts") });
  w.call(OPUS, "Read", { file_path: w.file("src/http.ts") });
  w.call(OPUS, "Read", { file_path: w.file("src/sync.ts") });
  w.call(OPUS, "Grep", { pattern: "fetch\\(", path: w.file("src") });
  w.call(OPUS, "Write", { file_path: w.file("src/retry.ts"), content: "export async function retry() {}" }, { out: 820 });
  w.call(OPUS, "Edit", { file_path: w.file("src/sync.ts"), old_string: "await fetch(url)", new_string: "await retry(() => fetch(url))" }, { out: 360 });
  w.call(OPUS, "Bash", { command: "npm test -- --silent sync" }, { error: "FAIL tests/sync.test.ts\n  timeout of 5000ms exceeded", wait: [15, 40] });
  w.call(OPUS, "Bash", { command: "npm test -- --silent sync" }, { error: "FAIL tests/sync.test.ts\n  timeout of 5000ms exceeded", wait: [15, 40] });
  w.call(OPUS, "Edit", { file_path: w.file("tests/sync.test.ts"), old_string: "jest.setTimeout(5000)", new_string: "jest.useFakeTimers()" }, { out: 430 });
  w.call(OPUS, "Bash", { command: "npm test -- --silent sync" }, { wait: [15, 40] });
  w.say(OPUS, "sync now retries failed requests up to 3 times with exponential backoff.", { out: 240 });
  write(home, folder, id, w.lines, [], w);
}

function sessionThree(root: string, home: string, folder: string, now: number) {
  const id = "e47a0d95-6c3b-4f18-8d2e-91b5a4c07e6f";
  const w = new Writer(root, now - 52 * 3600e3, 131);
  w.lines.push({ type: "ai-title", aiTitle: "Rename the notes folder option", sessionId: id });
  w.prompt("Rename the --dir option to --notes-dir everywhere.");
  w.call(SONNET, "Grep", { pattern: "--dir", path: w.file(".") });
  w.call(SONNET, "Edit", { file_path: w.file("src/cli.ts"), old_string: "--dir", new_string: "--notes-dir" }, { out: 260 });
  w.call(SONNET, "Edit", { file_path: w.file("README.md"), old_string: "--dir", new_string: "--notes-dir" }, { out: 220 });
  w.call(SONNET, "Bash", { command: "npm test -- --silent" }, { wait: [15, 40] });
  w.say(SONNET, "Renamed the option in the CLI and the README; tests pass.", { out: 130 });
  write(home, folder, id, w.lines, [], w);
}

function write(home: string, folder: string, id: string, lines: Line[], subs: Array<{ id: string; w: Writer; meta: Record<string, unknown> }>, main: Writer) {
  const dir = path.join(home, "projects", folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, jsonl(lines), "utf8");
  if (subs.length) {
    const subDir = path.join(dir, id, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    for (const s of subs) {
      fs.writeFileSync(path.join(subDir, `agent-${s.id}.jsonl`), jsonl(s.w.lines), "utf8");
      fs.writeFileSync(path.join(subDir, `agent-${s.id}.meta.json`), JSON.stringify(s.meta), "utf8");
    }
  }
  // make the file times match the story (the board shows "live" only for files touched in the last 90 seconds)
  const end = new Date(main.t);
  fs.utimesSync(file, end, end);
}

/** Creates the three demo sessions under <claudeHome>/projects/<encoded project path>/. Safe to run again: files are overwritten. */
export function writeDemoSessions(claudeHome: string, projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const folder = root.replace(/[^A-Za-z0-9]/g, "-");
  const now = Date.now();
  sessionOne(root, claudeHome, folder, now);
  sessionTwo(root, claudeHome, folder, now);
  sessionThree(root, claudeHome, folder, now);
  return path.join(claudeHome, "projects", folder);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [home, project] = process.argv.slice(2);
  if (!home || !project) { console.error("usage: node scripts/make-demo-sessions.ts <claude-home> <project-root>"); process.exit(1); }
  console.log("Wrote demo sessions to", writeDemoSessions(path.resolve(home), project));
}
