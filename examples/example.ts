import type { Workflow } from "../src/spec/workflow.js";
import type { CodeFn, Tool } from "../src/runtime/engine.js";

/** What the CLI needs from an example module. */
export interface Example {
  main: Workflow;
  workflows: Record<string, Workflow>;     // registry incl. main and every sub-workflow
  tools: Record<string, Tool>;
  code?: Record<string, CodeFn>;
  inputs: Array<Record<string, unknown>>;  // default demo inputs
  inputFromArgs(args: Record<string, string | boolean>): Record<string, unknown> | null;
}
