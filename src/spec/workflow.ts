/**
 * Workflow spec: an explicit decision tree.
 *
 *  decide  — Jev Choice. Options are the outgoing edges. Confidence below
 *            `min_confidence` takes `on_unsure` (or stops for a human).
 *  check   — Jev Noul. A yes/no statement about the state. Probability near 0.5
 *            (inside `unsure_band`) takes `on_unsure`.
 *  assess  — Jev Score. Places the state on an ordered rubric and stores the
 *            result in `assessments[store_as]`. Never branches by itself;
 *            a `switch` or `check` branches on it afterwards.
 *  act     — call a tool with args mapped from state; result stored in facts.
 *  code    — pure function over state (derive facts, shape output).
 *  switch  — deterministic branch on a state value.
 *  sub     — run another workflow with mapped input; its output becomes a fact.
 *  parallel— run several act/sub branches concurrently; results keyed by branch id.
 *  human   — stop and hand the run to a person.
 *  end     — terminal.
 */
import { z } from "zod";
import { Budget } from "./state.js";

const NodeId = z.string().min(1);
const Reads = z.array(z.string()).optional();

/** Additional questions batched into the same Jev request; answers land in assessments/facts. */
const ExtraNoul = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }),
});
const ExtraScore = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  levels: z.array(z.string()).min(2).max(10),
});
export const ExtraQuestion = z.discriminatedUnion("type", [ExtraNoul, ExtraScore]);
export type ExtraQuestion = z.infer<typeof ExtraQuestion>;

export const DecideNode = z.object({
  kind: z.literal("decide"),
  id: NodeId,
  title: z.string().optional(),
  instructions: z.string(),
  reads: Reads,
  options: z.record(z.object({ description: z.string(), next: NodeId })).refine(
    (o) => Object.keys(o).length >= 2 && Object.keys(o).length <= 255,
    "decide needs 2..255 options",
  ),
  min_confidence: z.number().min(0).max(1).default(0.6),
  on_unsure: NodeId.optional(),
  extra: z.record(ExtraQuestion).optional(),
});

export const CheckNode = z.object({
  kind: z.literal("check"),
  id: NodeId,
  title: z.string().optional(),
  instructions: z.string(),
  reads: Reads,
  criteria: z.object({ true: z.string(), false: z.string() }),
  threshold: z.number().min(0).max(1).default(0.5),
  unsure_band: z.number().min(0).max(0.5).default(0),
  on_true: NodeId,
  on_false: NodeId,
  on_unsure: NodeId.optional(),
  extra: z.record(ExtraQuestion).optional(),
});

export const AssessNode = z.object({
  kind: z.literal("assess"),
  id: NodeId,
  title: z.string().optional(),
  instructions: z.string(),
  reads: Reads,
  levels: z.array(z.string()).min(2).max(10),
  store_as: z.string().min(1),
  next: NodeId,
  extra: z.record(ExtraQuestion).optional(),
});

export const ActNode = z.object({
  kind: z.literal("act"),
  id: NodeId,
  title: z.string().optional(),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  store_as: z.string().optional(),
  summary: z.string().optional(),           // template, e.g. "created ticket ${facts.ticket.id}"
  next: NodeId,
  on_error: NodeId.optional(),
});

export const CodeNode = z.object({
  kind: z.literal("code"),
  id: NodeId,
  title: z.string().optional(),
  fn: z.string().min(1),
  next: NodeId,
});

export const SwitchNode = z.object({
  kind: z.literal("switch"),
  id: NodeId,
  title: z.string().optional(),
  on: z.string().min(1),                    // state path
  cases: z.record(NodeId),
  default: NodeId,
});

export const SubNode = z.object({
  kind: z.literal("sub"),
  id: NodeId,
  title: z.string().optional(),
  workflow: z.string().min(1),              // name in EngineOptions.workflows
  input: z.record(z.unknown()).default({}), // mapped from state like act args
  store_as: z.string().min(1),
  summary: z.string().optional(),
  next: NodeId,
  on_error: NodeId.optional(),              // child failed/halted; child needs_human always propagates
});

const ActBranch = z.object({ id: z.string().min(1), kind: z.literal("act"), tool: z.string().min(1), args: z.record(z.unknown()).default({}) });
const SubBranch = z.object({ id: z.string().min(1), kind: z.literal("sub"), workflow: z.string().min(1), input: z.record(z.unknown()).default({}) });
export const ParallelBranch = z.discriminatedUnion("kind", [ActBranch, SubBranch]);
export type ParallelBranch = z.infer<typeof ParallelBranch>;

export const ParallelNode = z.object({
  kind: z.literal("parallel"),
  id: NodeId,
  title: z.string().optional(),
  branches: z.array(ParallelBranch).min(2).refine((b) => new Set(b.map((x) => x.id)).size === b.length, "branch ids must be unique"),
  store_as: z.string().min(1),              // facts[store_as] = { [branch id]: result }
  next: NodeId,
  on_error: NodeId.optional(),              // any branch failed; partial results are still stored
});

export const HumanNode = z.object({
  kind: z.literal("human"),
  id: NodeId,
  title: z.string().optional(),
  question: z.string(),
  options: z.array(z.string()).default([]),
});

export const EndNode = z.object({
  kind: z.literal("end"),
  id: NodeId,
  title: z.string().optional(),
  outcome: z.enum(["succeeded", "failed"]),
  output: z.string().optional(),            // state path copied to state.output
});

export const Node = z.discriminatedUnion("kind", [
  DecideNode, CheckNode, AssessNode, ActNode, CodeNode, SwitchNode, SubNode, ParallelNode, HumanNode, EndNode,
]);
export type Node = z.infer<typeof Node>;
export type NodeKind = Node["kind"];

export const Workflow = z.object({
  name: z.string().min(1),
  version: z.string().default("1"),
  goal: z.object({ text: z.string(), success_criteria: z.array(z.string()).default([]) }),
  start: NodeId,
  budget: Budget.partial().default({}),
  nodes: z.array(Node).min(1),
});
export type Workflow = z.infer<typeof Workflow>;
export type WorkflowInput = z.input<typeof Workflow>;

/** Outgoing edges of a node as [label, target] pairs. Used by validation and the live view. */
export function edgesOf(n: Node): Array<[string, string]> {
  switch (n.kind) {
    case "decide": {
      const e: Array<[string, string]> = Object.entries(n.options).map(([k, v]) => [k, v.next]);
      if (n.on_unsure) e.push(["unsure", n.on_unsure]);
      return e;
    }
    case "check": {
      const e: Array<[string, string]> = [["true", n.on_true], ["false", n.on_false]];
      if (n.on_unsure) e.push(["unsure", n.on_unsure]);
      return e;
    }
    case "assess": return [["next", n.next]];
    case "act": {
      const e: Array<[string, string]> = [["ok", n.next]];
      if (n.on_error) e.push(["error", n.on_error]);
      return e;
    }
    case "code": return [["next", n.next]];
    case "sub":
    case "parallel": {
      const e: Array<[string, string]> = [["ok", n.next]];
      if (n.on_error) e.push(["error", n.on_error]);
      return e;
    }
    case "switch": {
      const e: Array<[string, string]> = Object.entries(n.cases);
      e.push(["default", n.default]);
      return e;
    }
    case "human":
    case "end":
      return [];
  }
}

export class WorkflowError extends Error {}

/** Parse + structural validation: unique ids, all edges resolve, start exists, no orphans. */
export function loadWorkflow(raw: unknown): Workflow {
  const wf = Workflow.parse(raw);
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) throw new WorkflowError(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (!ids.has(wf.start)) throw new WorkflowError(`start node "${wf.start}" does not exist`);
  for (const n of wf.nodes) {
    for (const [label, target] of edgesOf(n)) {
      if (!ids.has(target)) throw new WorkflowError(`node "${n.id}" edge "${label}" points to unknown node "${target}"`);
    }
    if (n.kind === "decide" && "unsure" in n.options) {
      throw new WorkflowError(`node "${n.id}": "unsure" is reserved; use on_unsure`);
    }
  }
  // reachability
  const seen = new Set<string>([wf.start]);
  const stack = [wf.start];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  while (stack.length) {
    const n = byId.get(stack.pop()!)!;
    for (const [, t] of edgesOf(n)) if (!seen.has(t)) { seen.add(t); stack.push(t); }
  }
  const orphans = wf.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  if (orphans.length) throw new WorkflowError(`unreachable nodes: ${orphans.join(", ")}`);
  if (!wf.nodes.some((n) => n.kind === "end")) throw new WorkflowError("workflow has no end node");
  return wf;
}

/** Names of workflows this one calls through sub / parallel nodes. */
export function subWorkflowsOf(wf: Workflow): string[] {
  const out = new Set<string>();
  for (const n of wf.nodes) {
    if (n.kind === "sub") out.add(n.workflow);
    if (n.kind === "parallel") for (const b of n.branches) if (b.kind === "sub") out.add(b.workflow);
  }
  return [...out];
}

/** Validate a registry: every referenced sub-workflow exists (cycles are allowed; depth is capped at run time). */
export function checkRegistry(workflows: Record<string, Workflow>): void {
  for (const [name, wf] of Object.entries(workflows)) {
    for (const ref of subWorkflowsOf(wf)) {
      if (!workflows[ref]) throw new WorkflowError(`workflow "${name}" references unknown workflow "${ref}"`);
    }
  }
}
