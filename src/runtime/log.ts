import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventSink } from "./events.js";

/** Append every event as one JSON line to <dir>/<run_id>.jsonl. */
export function jsonlSink(dir = ".jev/runs"): EventSink {
  mkdirSync(dir, { recursive: true });
  // child runs (id "root.node[.branch]") log into the root run's file
  return (e) => appendFileSync(join(dir, `${e.run_id.split(".")[0]}.jsonl`), JSON.stringify(e) + "\n");
}
