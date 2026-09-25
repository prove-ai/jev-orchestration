import type { RunState } from "../spec/state.js";

export type RunEvent =
  | { type: "run.start"; run_id: string; at: string; workflow: string; parent: string | null; depth: number }
  | { type: "node.enter"; run_id: string; at: string; step: number; node: string; kind: string }
  | { type: "jev.ask"; run_id: string; at: string; step: number; node: string; questions: string[]; view: unknown }
  | { type: "jev.answer"; run_id: string; at: string; step: number; node: string; answers: unknown; latency_ms: number; model: string }
  | { type: "tool.call"; run_id: string; at: string; step: number; node: string; tool: string; args: unknown }
  | { type: "tool.result"; run_id: string; at: string; step: number; node: string; tool: string; outcome: "ok" | "error"; summary: string; duration_ms: number }
  | { type: "agent"; run_id: string; at: string; step: number; node: string; agent: string; model: string | null; usage: { input_tokens: number; output_tokens: number } | null }
  | { type: "edge"; run_id: string; at: string; step: number; from: string; label: string; to: string }
  | { type: "state"; run_id: string; at: string; step: number; state: RunState }
  | { type: "run.end"; run_id: string; at: string; status: RunState["run"]["status"]; reason: string | null; spent: RunState["run"]["spent"] };

export type EventSink = (e: RunEvent) => void;
