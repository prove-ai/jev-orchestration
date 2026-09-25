/**
 * npm run demo -- [--example triage|research] [--message "..."] [--topic "..."]
 *                [--jev heuristic|http] [--agents mock|claude] [--live] [--port 4343]
 *
 * Reads .env: JEV_API_KEY / JEV_BASE_URL / JEV_MODEL select real Jev; ANTHROPIC_API_KEY (or an
 * `ant auth login` profile) selects Claude agents. Without them, deterministic stand-ins run.
 */
try { process.loadEnvFile(".env"); } catch { /* no .env: stand-ins */ }
for (const k of ["JEV_API_KEY", "JEV_BASE_URL", "JEV_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_AGENT_MODEL"]) if (process.env[k] === "") delete process.env[k];

import { run } from "./runtime/engine.js";
import { jsonlSink } from "./runtime/log.js";
import { HeuristicJev } from "./jev/mock.js";
import { jevFromEnv } from "./jev/client.js";
import { startLiveServer } from "./live/server.js";
import type { EventSink } from "./runtime/events.js";
import type { Example } from "../examples/example.js";

const args = parse(process.argv.slice(2));
const jevMode = args.jev ?? (process.env.JEV_API_KEY ? "http" : "heuristic");
const jev = jevMode === "http" ? jevFromEnv() : new HeuristicJev();
const agentMode = (args.agents ?? (process.env.ANTHROPIC_API_KEY ? "claude" : "mock")) as "claude" | "mock";

const exampleName = String(args.example ?? (args.topic ? "research" : "triage"));
const example: Example = exampleName === "research"
  ? (await import("../examples/research-review.js")).makeExample(agentMode)
  : (await import("../examples/support-triage.js")).example;

console.log(`example: ${example.main.name} · jev: ${jevMode === "http" ? `${process.env.JEV_MODEL ?? "jev-latest"} @ ${process.env.JEV_BASE_URL ?? "https://api.typesafe.ai/v1/systemone"}` : "heuristic stand-in (no JEV_API_KEY)"}`
  + (exampleName === "research" ? ` · agents: ${agentMode === "claude" ? process.env.CLAUDE_AGENT_MODEL ?? "claude-opus-5" : "mock"}` : ""));

const live = args.live ? await startLiveServer({ port: Number(args.port ?? 4343) }) : null;
if (live) console.log(`live view: ${live.url}`);

const inputs = example.inputFromArgs(args) ? [example.inputFromArgs(args)!] : example.inputs;
const log = jsonlSink();
for (const input of inputs) {
  const sinks: EventSink[] = [log];
  if (live) sinks.push(live.sink(Object.values(example.workflows)));
  const state = await run(input, {
    workflow: example.main, workflows: example.workflows, jev, tools: example.tools, code: example.code,
    onEvent: (e) => {
      for (const s of sinks) s(e);
      const indent = "  ".repeat(1 + (e.run_id.split(".").length - 1));
      if (e.type === "edge") console.log(`${indent}${e.from} --${e.label}--> ${e.to}`);
      if (e.type === "run.start" && e.parent) console.log(`${indent}↳ ${e.workflow} (${e.run_id})`);
    },
  });
  const sp = state.run.spent;
  console.log(`[${state.run.id}] ${state.run.status}${state.run.halt_reason ? ` (${state.run.halt_reason})` : ""}`
    + ` · steps ${sp.steps} · jev calls ${sp.jev_calls} · jev tokens ${sp.jev_input_tokens}`
    + (sp.agent_calls ? ` · agent calls ${sp.agent_calls} · agent tokens ${sp.agent_input_tokens}/${sp.agent_output_tokens}` : "") + ` · ${sp.wall_ms}ms`);
  if (state.output) console.log(`  output: ${JSON.stringify(state.output)}`);
  if (state.human) console.log(`  needs human: ${state.human.question} [${state.human.options.join(", ")}]`);
  console.log();
  if (live) await new Promise((r) => setTimeout(r, 400));
}

if (live) {
  console.log("live view stays up; ctrl-c to exit");
  await new Promise(() => {});
}

function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}
