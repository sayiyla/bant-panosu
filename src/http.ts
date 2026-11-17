// HTTP layer: a small server that listens on 127.0.0.1 only (or the local network in --phone mode, read-only).
// Write endpoints require a token embedded in the served page, so another website cannot make your browser write through this server.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPipelineSource } from "./pipelines.ts";
import { createSessionSource, defaultClaudeHome } from "./sessions.ts";
import { createSubagentSettings } from "./subagents.ts";
import { createTaskSource } from "./tasks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, "..", "web");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export interface ServerConfig {
  port: number;
  /** Project root (default: current directory). */
  project: string;
  /** Claude Code config directory (default: $CLAUDE_CONFIG_DIR or ~/.claude). */
  claudeHome?: string;
  pipelinesDir?: string;
  agentsDir?: string;
  runsDir?: string;
  modelsFile?: string;
  stateDir?: string;
  /** Windows Task Scheduler folder such as "\\MyTasks\\". The task strip stays off when this is not set. */
  tasksFolder?: string;
  /** Read-only access from the local network (private addresses only, with an access key). */
  phone?: boolean;
  /** Suppress the startup messages (used by tests). */
  quiet?: boolean;
}

/** 10/8, 172.16/12, 192.168/16 (also IPv4 embedded in IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "");
  return /^10\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4);
}
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === "IPv4" && !a.internal && isPrivateAddress(a.address)))
    .map((a) => a.address);
}
function isLoopback(req: http.IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 20_000) { reject(new HttpError(413, "Request body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(text || "{}") as Record<string, unknown>); } catch { reject(new HttpError(400, "Body is not JSON")); }
    });
    req.on("error", reject);
  });
}
const requireString = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new HttpError(400, `'${name}' is required`);
  return v;
};

export async function startServer(cfg: ServerConfig) {
  const root = path.resolve(cfg.project);
  const claudeHome = cfg.claudeHome ? path.resolve(cfg.claudeHome) : defaultClaudeHome();
  const pipelinesDir = path.resolve(cfg.pipelinesDir ?? path.join(root, "pipelines"));
  const agentsDir = path.resolve(cfg.agentsDir ?? path.join(root, "agents"));
  const runsDir = path.resolve(cfg.runsDir ?? path.join(root, "runs"));
  const modelsFile = path.resolve(cfg.modelsFile ?? path.join(root, "config", "models.yaml"));
  const stateDir = path.resolve(cfg.stateDir ?? path.join(root, ".bant-panosu"));

  const token = crypto.randomBytes(16).toString("hex");
  const accessKey = crypto.randomBytes(12).toString("hex");
  const lan = cfg.phone ? lanAddresses() : [];
  const allowedHosts = new Set(["127.0.0.1", "localhost", ...lan]);

  const sessions = createSessionSource({ root, claudeHome });
  const subagents = createSubagentSettings(root, path.join(stateDir, "changes.jsonl"));

  // Pipelines are optional: the tab appears only when the pipelines folder exists and contains at least one YAML file.
  const pipelines = createPipelineSource({ root, pipelinesDir, agentsDir, runsDir, modelsFile, stateDir });
  const hasPipelines = fs.existsSync(pipelinesDir) && pipelines.names().length > 0;
  const pipelinesNote = hasPipelines ? "" : `No pipelines found (looked for *.yaml in ${path.relative(root, pipelinesDir) || "."}); only the session views are available.`;
  const tasks = cfg.tasksFolder ? createTaskSource(cfg.tasksFolder, pipelines.names) : undefined;

  function requirePipelines() {
    if (!hasPipelines) throw new HttpError(404, pipelinesNote);
    return pipelines;
  }

  async function api(route: string, query: URLSearchParams, req: http.IncomingMessage): Promise<unknown> {
    if (req.method === "GET") {
      switch (route) {
        case "/api/status": return { project: path.basename(root), pipelines: hasPipelines, pipelinesNote, tasks: Boolean(tasks) && process.platform === "win32", readOnly: !isLoopback(req) };
        case "/api/subagents": return subagents.list();
        case "/api/tasks":
          if (!tasks) throw new HttpError(404, "Task strip is off (enable with --tasks-folder on Windows)");
          return await tasks.tasks();
        case "/api/pipelines": return { pipelines: requirePipelines().list() };
        case "/api/pipeline": return requirePipelines().pipeline(requireString(query.get("name"), "name"));
        case "/api/run": return requirePipelines().run(requireString(query.get("id"), "id"));
        case "/api/sessions": return sessions.list();
        case "/api/session": return await sessions.session(requireString(query.get("id"), "id"));
      }
    }
    if (req.method === "POST") {
      if (!isLoopback(req)) throw new HttpError(403, "Phone mode is read-only; make changes from the computer");
      if (req.headers["x-pano-token"] !== token) throw new HttpError(403, "Missing or wrong token; reload the page");
      const body = await readBody(req);
      switch (route) {
        case "/api/switch":
          if (typeof body.enabled !== "boolean") throw new HttpError(400, "'enabled' must be true or false");
          return requirePipelines().setSwitch({ pipeline: requireString(body.pipeline, "pipeline"), step: typeof body.step === "string" ? body.step : undefined, enabled: body.enabled });
        case "/api/model":
          return requirePipelines().setModel({ agent: requireString(body.agent, "agent"), model: typeof body.model === "string" ? body.model : undefined, tier: typeof body.tier === "string" ? body.tier : undefined });
        case "/api/subagent-model":
          return subagents.setModel({ file: requireString(body.file, "file"), model: requireString(body.model, "model") });
      }
    }
    throw new HttpError(404, `Unknown endpoint: ${req.method} ${route}`);
  }

  const server = http.createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
      res.end(body);
    };
    // Only requests with a known host name: a foreign domain pointed at this server (DNS rebinding) is rejected.
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!allowedHosts.has(hostName)) return send(403, "text/plain; charset=utf-8", "Local access only");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Phone mode: a client outside this computer must come from a private network address and carry the access key.
    // The key arrives in the address bar on first use and is stored in a cookie; later requests use the cookie.
    if (!isLoopback(req)) {
      if (!cfg.phone || !isPrivateAddress(req.socket.remoteAddress ?? "")) return send(403, "text/plain; charset=utf-8", "Local access only");
      const cookie = /(?:^|;\s*)pano_key=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (url.searchParams.get("key") === accessKey) {
        res.writeHead(302, { location: "/", "set-cookie": `pano_key=${accessKey}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`, "cache-control": "no-store" });
        return res.end();
      }
      if (cookie !== accessKey) return send(401, "text/plain; charset=utf-8", "Access key required: open the link printed on the computer");
    }

    if (url.pathname.startsWith("/api/")) {
      api(url.pathname, url.searchParams, req).then(
        (data) => send(200, "application/json; charset=utf-8", JSON.stringify(data)),
        (e: Error) => send(e instanceof HttpError ? e.status : 400, "application/json; charset=utf-8", JSON.stringify({ error: e.message })),
      );
      return;
    }

    // Static files: only plain files directly inside web/ (no sub-folders, no way out of the folder).
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
    const file = path.join(WEB_DIR, name);
    const type = MIME[path.extname(name)];
    if (!type || !fs.existsSync(file)) return send(404, "text/plain; charset=utf-8", "Not found");
    if (name === "index.html") return send(200, type, fs.readFileSync(file, "utf8").replaceAll("__PANO_TOKEN__", token));
    send(200, type, fs.readFileSync(file));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.phone ? "0.0.0.0" : "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  if (!cfg.quiet) {
    console.log(`Bant Panosu: http://127.0.0.1:${port}  (project: ${path.basename(root)})`);
    if (cfg.phone) {
      if (!lan.length) console.log("Phone mode: no private local network address found on this computer.");
      for (const a of lan) console.log(`On your phone (same Wi-Fi/network, read-only): http://${a}:${port}/?key=${accessKey}`);
    }
    if (pipelinesNote) console.log(pipelinesNote);
  }
  return { server, port, token, accessKey, close: () => new Promise<void>((r) => server.close(() => r())) };
}
