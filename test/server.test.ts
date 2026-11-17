import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createSwitchReader } from "../examples/switch-reader.ts";
import { startServer } from "../src/http.ts";
import { redact } from "../src/sessions.ts";
import { writeDemoSessions } from "../scripts/make-demo-sessions.ts";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bant-panosu-test-"));
const project = path.join(tmp, "project");
const claudeHome = path.join(tmp, "claude-home");
const stateDir = path.join(tmp, "state");
let srv: Awaited<ReturnType<typeof startServer>>;
let base = "";

/** Raw request so the Host header can be forged (fetch would not allow it). */
function raw(method: string, urlPath: string, opts: { host?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {};
    if (opts.host) headers.host = opts.host;
    if (opts.token) headers["x-pano-token"] = opts.token;
    if (data) headers["content-type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port: srv.port, path: urlPath, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const json = async (p: string) => (await fetch(base + p)).json() as Promise<Record<string, any>>;

before(async () => {
  fs.cpSync(path.join(repo, "examples", "demo-project"), project, { recursive: true });
  writeDemoSessions(claudeHome, project);
  srv = await startServer({ port: 0, project, claudeHome, stateDir, quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("redact", () => {
  it("masks secrets", () => {
    assert.equal(redact("API_TOKEN=abc123 npm run x"), "API_TOKEN=*** npm run x");
    assert.match(redact("curl -H 'Authorization: Bearer abc.def' https://x"), /Bearer \*\*\*/);
    assert.doesNotMatch(redact("key sk-abcdef1234567890abcdef"), /1234567890/);
    assert.doesNotMatch(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), /klmnop/);
    assert.doesNotMatch(redact("git clone https://user:hunter2@example.com/x.git"), /hunter2/);
    assert.equal(redact("x".repeat(500), 40).length, 40);
  });
});

describe("sessions", () => {
  it("lists the demo sessions and parses one", async () => {
    const list = await json("/api/sessions");
    assert.equal(list.sessions.length, 3);
    assert.equal(list.folder, undefined, "no absolute paths in the API");
    const s = await json(`/api/session?id=${list.sessions[0].id}`);
    assert.equal(s.agents.length, 3);
    assert.ok(s.totals.usd > 0 && s.totals.errors >= 3 && s.totals.retries >= 1 && s.handoffs.length >= 2);
    const text = JSON.stringify(s);
    assert.ok(!text.includes(JSON.stringify(project).slice(1, -1)), "paths are shortened to project-relative");
    assert.ok(!text.includes("demo-token-123"), "secret value from a command is masked");
  });
  it("rejects bad ids", async () => {
    const r = await fetch(base + "/api/session?id=../../etc/passwd");
    assert.equal(r.status, 400);
  });
});

describe("pipelines", () => {
  it("reads pipelines and runs", async () => {
    const list = await json("/api/pipelines");
    assert.deepEqual(list.pipelines.map((p: any) => p.name), ["blog-post", "release-notes"]);
    const p = await json("/api/pipeline?name=blog-post");
    assert.equal(p.steps.length, 7);
    assert.ok(p.edges.some((e: any) => e.source === "research" && e.target === "outline"));
    assert.equal(p.steps.find((s: any) => s.id === "fact_check").review, true);
    const run = await json(`/api/run?id=${p.runs[0].id}`);
    assert.equal(run.steps.research.status, "done");
  });
  it("switches steps and pipelines, only disabled ones are stored", async () => {
    const post = (body: unknown) => raw("POST", "/api/switch", { token: srv.token, body });
    assert.equal((await post({ pipeline: "blog-post", step: "seo_pass", enabled: false })).status, 200);
    const sw = JSON.parse(fs.readFileSync(path.join(stateDir, "switches.json"), "utf8"));
    assert.deepEqual(sw.steps, { "blog-post": { seo_pass: false } });
    const reader = createSwitchReader(stateDir);
    assert.equal(reader.stepOff("blog-post", "seo_pass"), true);
    assert.equal(reader.stepOff("blog-post", "draft"), false);
    assert.equal((await post({ pipeline: "blog-post", enabled: false })).status, 200);
    assert.equal(reader.pipelineOff("blog-post"), true);
    assert.equal((await post({ pipeline: "blog-post", step: "seo_pass", enabled: true })).status, 200);
    assert.equal((await post({ pipeline: "blog-post", enabled: true })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "switches.json"), "utf8")), { pipelines: {}, steps: {} });
    assert.equal((await post({ pipeline: "blog-post", step: "nope", enabled: false })).status, 400);
    assert.equal((await post({ pipeline: "../x", enabled: false })).status, 400);
    assert.ok(fs.readFileSync(path.join(stateDir, "changes.jsonl"), "utf8").includes('"type":"switch"'));
  });
  it("changes a model line and keeps the rest of the file", async () => {
    const file = path.join(project, "agents", "researcher.md");
    const original = fs.readFileSync(file, "utf8");
    const r = await raw("POST", "/api/model", { token: srv.token, body: { agent: "researcher", model: "google/gemini-3-flash" } });
    assert.equal(r.status, 200);
    const changed = fs.readFileSync(file, "utf8");
    assert.match(changed, /primary: google\/gemini-3-flash/);
    assert.match(changed, /- anthropic\/claude-haiku-5-5/, "old primary became the fallback");
    assert.equal(changed.split("\n").length, original.split("\n").length);
    assert.equal((await raw("POST", "/api/model", { token: srv.token, body: { agent: "researcher", model: "not/a-model" } })).status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), changed, "a rejected change leaves the file alone");
  });
  it("changes a subagent model", async () => {
    const r = await raw("POST", "/api/subagent-model", { token: srv.token, body: { file: ".claude/agents/doc-writer.md", model: "haiku" } });
    assert.equal(r.status, 200);
    assert.match(fs.readFileSync(path.join(project, ".claude", "agents", "doc-writer.md"), "utf8"), /^model: haiku$/m);
    assert.equal((await raw("POST", "/api/subagent-model", { token: srv.token, body: { file: "../../x.md", model: "haiku" } })).status, 400);
  });
});

describe("security", () => {
  it("rejects writes without the token", async () => {
    assert.equal((await raw("POST", "/api/switch", { body: { pipeline: "blog-post", enabled: false } })).status, 403);
    assert.equal((await raw("POST", "/api/switch", { token: "wrong", body: { pipeline: "blog-post", enabled: false } })).status, 403);
  });
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    assert.equal((await raw("GET", "/api/status", { host: "evil.example.com" })).status, 403);
    assert.equal((await raw("GET", "/api/status", { host: "localhost:" + srv.port })).status, 200);
  });
  it("serves only flat files from web/", async () => {
    assert.equal((await raw("GET", "/..%2Fpackage.json")).status, 404);
    assert.equal((await raw("GET", "/package.json")).status, 404);
    const page = await (await fetch(base + "/")).text();
    assert.ok(page.includes(srv.token) && !page.includes("__PANO_TOKEN__"));
  });
  it("hides the tasks API unless a task folder is configured", async () => {
    assert.equal((await fetch(base + "/api/tasks")).status, 404);
    assert.equal((await json("/api/status")).tasks, false);
  });
});

describe("without pipelines", () => {
  it("still works for sessions and says so", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bant-panosu-bare-"));
    const s2 = await startServer({ port: 0, project: bare, claudeHome, quiet: true });
    try {
      const st = (await (await fetch(`http://127.0.0.1:${s2.port}/api/status`)).json()) as any;
      assert.equal(st.pipelines, false);
      assert.match(st.pipelinesNote, /No pipelines found/);
      assert.equal((await fetch(`http://127.0.0.1:${s2.port}/api/pipelines`)).status, 404);
      const sess = (await (await fetch(`http://127.0.0.1:${s2.port}/api/sessions`)).json()) as any;
      assert.equal(sess.found, false);
    } finally {
      await s2.close();
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
