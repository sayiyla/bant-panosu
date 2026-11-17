// Windows Task Scheduler strip (read-only, off by default). Shows the tasks in one folder: state, last and next run,
// last result and which pipeline each task runs. It never creates, enables, disables or runs a task.
// On other platforms, or when the folder does not exist, it returns an empty list.
import { execFile } from "node:child_process";
import fs from "node:fs";

interface RawTask { name: string; state: string; last: string | null; next: string | null; result: number | null; exe: string; args: string }

const FOLDER = /^\\[A-Za-z0-9 _.-]+\\$/;

export function createTaskSource(folder: string, pipelineNames: () => string[]) {
  if (!FOLDER.test(folder)) throw new Error(`Invalid task folder (expected something like "\\MyTasks\\"): ${folder}`);
  let cache: { time: number; value: unknown } | undefined;

  function query(): Promise<RawTask[]> {
    if (process.platform !== "win32") return Promise.resolve([]);
    // Dates come back as ISO strings and the result as a number; no tasks gives an empty array.
    // Top-level commands are joined with ";" because a one-line -Command does not accept line breaks.
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$t = Get-ScheduledTask -TaskPath '${folder}'`,
      "$s = @($t | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; $a = $_.Actions | Select-Object -First 1; " +
        "[pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; " +
        "last=$(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null }); " +
        "next=$(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }); " +
        "result=$i.LastTaskResult; exe=[string]$a.Execute; args=[string]$a.Arguments } })",
      "ConvertTo-Json -InputObject $s -Compress -Depth 3",
    ].join("; ");
    return new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => {
        if (err) return resolve([]);
        try {
          const v = JSON.parse(out.toString().trim() || "[]") as RawTask[] | RawTask;
          resolve(Array.isArray(v) ? v : [v]);
        } catch {
          resolve([]);
        }
      });
    });
  }

  /** Finds the pipeline a task runs: the task's command (and the .cmd/.bat/.vbs script it starts) is searched for a pipeline name. */
  function findPipeline(t: RawTask, names: string[]): { pipeline: string | null; command: string | null } {
    const scripts = [t.exe, t.args].join(" ").match(/[A-Za-z]:\\[^"]+?\.(?:cmd|bat|vbs)/gi) ?? [];
    let text = "";
    for (const s of scripts) {
      try {
        let m = fs.readFileSync(s, "utf8");
        const inner = m.match(/[A-Za-z]:\\[^"]+?\.(?:cmd|bat)/i)?.[0];
        if (s.toLowerCase().endsWith(".vbs") && inner) { try { m += "\n" + fs.readFileSync(inner, "utf8"); } catch { /* missing */ } }
        text += m;
      } catch { /* missing file */ }
    }
    const command = text.match(/node(?:\.exe)?"?\s+([^>\r\n]+?)\s*(?:>>|$)/im)?.[1]?.trim() ?? null;
    const haystack = `${command ?? ""} ${t.args}`;
    const longest = [...names].sort((a, b) => b.length - a.length).find((n) => haystack.includes(n) || t.name === n || t.name.startsWith(`${n}-`));
    return { pipeline: longest ?? null, command };
  }

  async function tasks() {
    if (cache && Date.now() - cache.time < 60_000) return cache.value;
    const names = pipelineNames();
    const raw = await query();
    const value = {
      folder,
      supported: process.platform === "win32",
      tasks: raw
        .map((t) => {
          const p = findPipeline(t, names);
          return { name: t.name, enabled: t.state !== "Disabled", state: t.state, last: t.last, next: t.state === "Disabled" ? null : t.next, result: t.result, success: t.result === 0, pipeline: p.pipeline, command: p.command };
        })
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.next ?? "9").localeCompare(b.next ?? "9") || a.name.localeCompare(b.name)),
    };
    cache = { time: Date.now(), value };
    return value;
  }

  return { tasks };
}
