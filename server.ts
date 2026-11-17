// Bant Panosu command line:  node server.ts --project <path> [options]   (run `node server.ts --help`)
import { startServer } from "./src/http.ts";

const HELP = `Bant Panosu: local dashboard for Claude Code sessions and YAML agent pipelines.

Usage: node server.ts [options]      (or: npm start -- [options])

  --project <path>        Project whose sessions and pipelines are shown (default: current directory)
  --port <number>         Port (default: 4517)
  --claude-home <path>    Claude Code config folder (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --pipelines <path>      Folder with pipeline *.yaml files (default: <project>/pipelines)
  --agents <path>         Folder with pipeline agent *.md files (default: <project>/agents)
  --runs <path>           Folder with run records (default: <project>/runs)
  --models <path>         Optional models config YAML (default: <project>/config/models.yaml)
  --state <path>          Where switches.json and changes.jsonl are written (default: <project>/.bant-panosu)
  --tasks-folder <name>   Windows only: show the Task Scheduler folder, e.g. "\\MyTasks\\" (off by default)
  --phone                 Read-only access from your phone on the same network (prints a link with an access key)
  --help                  Show this help
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(value("port") ?? 4517);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid port: ${value("port")}`);
  process.exit(1);
}

try {
  await startServer({
    port,
    project: value("project") ?? process.cwd(),
    claudeHome: value("claude-home"),
    pipelinesDir: value("pipelines"),
    agentsDir: value("agents"),
    runsDir: value("runs"),
    modelsFile: value("models"),
    stateDir: value("state"),
    tasksFolder: value("tasks-folder"),
    phone: argv.includes("--phone"),
  });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use. The board may already be running; try another port with --port <number>` : err.message);
  process.exit(1);
}
