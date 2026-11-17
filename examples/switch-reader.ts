// Example "switch reader" for your own orchestrator.
//
// The board writes <state dir>/switches.json (default: <project>/.bant-panosu/switches.json):
//
//   { "pipelines": { "blog-post": false }, "steps": { "blog-post": { "seo_pass": false } } }
//
// Only things that are switched OFF are stored. A missing or broken file means "everything is on",
// so the board can never lock your pipelines. This module re-reads the file on every call, which is
// cheap and means a switch takes effect on the very next step.
//
// How an orchestrator should react (this is also what the board's "What happens if you turn it off" text assumes):
//   - step is off and `optional: true`  -> skip it (record status "skipped") and carry on
//   - step is off and not optional      -> stop the run at that step (status "awaiting-approval"); later steps do not run;
//                                          turning the step back on and resuming the run continues from there
//   - pipeline is off                   -> run nothing; the run waits (status "awaiting-approval")
//
//   import { createSwitchReader } from "./switch-reader.ts";
//   const sw = createSwitchReader(".bant-panosu");
//   if (sw.pipelineOff("blog-post")) { /* park the run */ }
//   for (const step of pipeline.steps) {
//     if (sw.stepOff("blog-post", step.id)) { if (step.optional) { markSkipped(step); continue; } else { parkRun(step); break; } }
//     await runStep(step);
//   }
import fs from "node:fs";
import path from "node:path";

interface Switches {
  pipelines?: Record<string, boolean>;
  steps?: Record<string, Record<string, boolean>>;
}

export function createSwitchReader(stateDir: string) {
  const file = path.join(stateDir, "switches.json");
  const read = (): Switches => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Switches;
    } catch {
      return {}; // missing or unreadable: everything stays on
    }
  };
  return {
    /** true when the whole pipeline is switched off */
    pipelineOff: (pipeline: string): boolean => read().pipelines?.[pipeline] === false,
    /** true when this step is switched off */
    stepOff: (pipeline: string, step: string): boolean => read().steps?.[pipeline]?.[step] === false,
  };
}
