// Claude Code subagent settings (<project>/.claude/agents/*.md). Works in any project and has no dependencies.
// Reads: name, description, model, effort, tools. Writes: only the `model:` line of the front matter
// (inserted below `name:` when missing).
import fs from "node:fs";
import path from "node:path";

const FILE_NAME = /^[A-Za-z0-9_.-]+$/;
/** Model values a Claude Code subagent accepts: aliases and full model ids. */
export const SUBAGENT_MODELS = ["inherit", "haiku", "sonnet", "opus", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"];

/** Top-level "key: value" lines of a plain YAML front matter (multi-line values keep their first line). */
function frontMatterFields(text: string): { fields: Record<string, string>; lines: string[]; end: number } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((s, i) => i > 0 && s.trim() === "---");
  if (end < 0) return undefined;
  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = (lines[i] ?? "").match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fields[m[1]!] = (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return { fields, lines, end };
}

export function createSubagentSettings(root: string, changeLog?: string) {
  const dir = path.join(root, ".claude", "agents");

  function list() {
    if (!fs.existsSync(dir)) return { folder: null, agents: [], models: SUBAGENT_MODELS };
    const agents = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .flatMap((f) => {
        const b = frontMatterFields(fs.readFileSync(path.join(dir, f), "utf8"));
        if (!b) return [];
        const a = b.fields;
        return [{
          file: `.claude/agents/${f}`,
          name: a.name || f.replace(/\.md$/, ""),
          description: (a.description ?? "").slice(0, 300),
          model: a.model || "inherit",
          modelWritten: Boolean(a.model),
          effort: a.effort || null,
          tools: a.tools ? a.tools.split(",").map((x) => x.trim()).filter(Boolean) : [],
        }];
      });
    return { folder: ".claude/agents", agents, models: SUBAGENT_MODELS };
  }

  function setModel(g: { file: string; model: string }) {
    const name = path.basename(g.file);
    if (!FILE_NAME.test(name) || !name.endsWith(".md")) throw new Error(`Invalid agent file: ${g.file}`);
    if (!SUBAGENT_MODELS.includes(g.model)) throw new Error(`Unknown model: ${g.model}`);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`Agent not found: ${name}`);
    const original = fs.readFileSync(file, "utf8");
    const b = frontMatterFields(original);
    if (!b) throw new Error(`${name}: YAML front matter not found`);
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const from = b.fields.model || "inherit";
    const i = b.lines.findIndex((s, j) => j > 0 && j < b.end && /^model:/.test(s));
    if (i >= 0) b.lines[i] = `model: ${g.model}`;
    else {
      const nameLine = b.lines.findIndex((s, j) => j > 0 && j < b.end && /^name:/.test(s));
      b.lines.splice(nameLine >= 0 ? nameLine + 1 : 1, 0, `model: ${g.model}`);
    }
    fs.writeFileSync(file + ".tmp", b.lines.join(eol), "utf8");
    fs.renameSync(file + ".tmp", file);
    if (frontMatterFields(fs.readFileSync(file, "utf8"))?.fields.model !== g.model) {
      fs.writeFileSync(file, original, "utf8");
      throw new Error(`${name}: change could not be read back and was rolled back`);
    }
    if (changeLog) {
      try {
        fs.mkdirSync(path.dirname(changeLog), { recursive: true });
        fs.appendFileSync(changeLog, JSON.stringify({ time: new Date().toISOString(), type: "subagent-model", file: `.claude/agents/${name}`, from, to: g.model }) + "\n", "utf8");
      } catch { /* the log is optional */ }
    }
    return { ok: true, from, to: g.model };
  }

  return { list, setModel };
}
