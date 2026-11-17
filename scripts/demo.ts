// `npm run demo`: generates made-up Claude Code sessions for examples/demo-project and starts the board on them.
// Nothing outside this repository is read or written. Usage: npm run demo -- [--port 4517] [--phone]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/http.ts";
import { writeDemoSessions } from "./make-demo-sessions.ts";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(repo, "examples", "demo-project");
const claudeHome = path.join(repo, "examples", "demo-claude-home");
const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 4517;

writeDemoSessions(claudeHome, project);
console.log("Demo data written to examples/demo-claude-home (made-up sessions, not your own).");
await startServer({ port, project, claudeHome, phone: argv.includes("--phone"), stateDir: path.join(repo, "examples", ".demo-state") });
