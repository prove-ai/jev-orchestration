/**
 * RunState: the single document that flows through a run.
 *
 * Design rules
 *  - Jev never sees the whole document. A node declares `reads` and only those
 *    paths (plus goal, last outcome and a short history tail) are sent.
 *  - Everything Jev returns is recorded verbatim (probabilities included) so the
 *    live view and the audit log can show *why* a branch was taken.
 *  - `facts` is the working memory. Tools and code write to it; Jev only reads it.
 *  - `assessments` is where Score answers land (rubric level + distribution).
 *  - Budget and loop guards live in code, not in the model.
 */
import { z } from "zod";

export const JevMode = z.enum(["choice", "noul", "score"]);
export type JevMode = z.infer<typeof JevMode>;

export const FactSource = z.enum(["input", "tool", "code", "jev", "human"]);

export const Fact = z.object({
  value: z.unknown(),
  source: FactSource,
  step: z.number().int().nonnegative(),
  at: z.string(),
});
export type Fact = z.infer<typeof Fact>;

/** Result of a Score question, keyed by `store_as` in the node. */
export const Assessment = z.object({
  level: z.number().int().nonnegative(),      // argmax level index
  label: z.string(),                          // the level text
  score: z.number(),                          // weighted mean 0..n-1 (e.g. 2.68 = between level 2 and 3)
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.number()),        // by level index
  step: z.number().int().nonnegative(),
});
export type Assessment = z.infer<typeof Assessment>;

/** One Jev-backed routing decision (decide / check nodes) or assessment (assess nodes). */
export const Decision = z.object({
  step: z.number().int().nonnegative(),
  node: z.string(),
  mode: JevMode,
  question: z.string(),
  answer: z.unknown(),                        // choice key | noul probability | score
  confidence: z.number().nullable(),
  probabilities: z.record(z.number()).nullable(),
  edge: z.string(),                           // option key, "true"/"false", "unsure", or "stored"
  next: z.string().nullable(),
  escalated: z.boolean(),
  latency_ms: z.number(),
  input_tokens: z.number().nullable(),
  model: z.string().nullable(),
});
export type Decision = z.infer<typeof Decision>;

export const ActionOutcome = z.enum(["ok", "error"]);

export const ActionRecord = z.object({
  step: z.number().int().nonnegative(),
  node: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()),
  outcome: ActionOutcome,
  summary: z.string(),
  error: z.string().nullable(),
  duration_ms: z.number(),
});
export type ActionRecord = z.infer<typeof ActionRecord>;

export const Budget = z.object({
  max_steps: z.number().int().positive().default(50),
  max_jev_calls: z.number().int().positive().default(40),
  max_jev_input_tokens: z.number().int().positive().default(400_000),
  max_wall_ms: z.number().int().positive().default(120_000),
  max_visits_per_node: z.number().int().positive().default(5),
  max_depth: z.number().int().positive().default(4),   // sub-workflow nesting
});
export type Budget = z.infer<typeof Budget>;

export const Spent = z.object({
  steps: z.number().int().nonnegative(),
  jev_calls: z.number().int().nonnegative(),
  jev_input_tokens: z.number().int().nonnegative(),
  agent_calls: z.number().int().nonnegative(),        // generative model calls made by agent tools (incl. sub-runs)
  agent_input_tokens: z.number().int().nonnegative(),
  agent_output_tokens: z.number().int().nonnegative(),
  wall_ms: z.number().nonnegative(),
});
export type Spent = z.infer<typeof Spent>;

export const RunStatus = z.enum(["running", "succeeded", "failed", "halted", "needs_human"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const HistoryLine = z.object({ step: z.number().int(), node: z.string(), line: z.string() });

export const RunState = z.object({
  run: z.object({
    id: z.string(),
    workflow: z.string(),
    workflow_version: z.string(),
    started_at: z.string(),
    updated_at: z.string(),
    status: RunStatus,
    cursor: z.string(),                       // current node id
    step: z.number().int().nonnegative(),
    parent: z.string().nullable(),            // parent run id when started by a sub/parallel node
    depth: z.number().int().nonnegative(),
    budget: Budget,
    spent: Spent,
    halt_reason: z.string().nullable(),       // set when status is halted/failed/needs_human
  }),
  goal: z.object({
    text: z.string(),
    success_criteria: z.array(z.string()),
  }),
  input: z.record(z.unknown()),               // immutable task input
  facts: z.record(Fact),                      // working memory
  assessments: z.record(Assessment),          // score results
  decisions: z.array(Decision),
  actions: z.array(ActionRecord),
  last: z.object({
    node: z.string().nullable(),
    kind: z.string().nullable(),
    outcome: ActionOutcome.nullable(),
    error: z.string().nullable(),
  }),
  history: z.array(HistoryLine),              // one human-readable line per step
  human: z.object({
    node: z.string(),
    question: z.string(),
    options: z.array(z.string()),
  }).nullable(),
  output: z.unknown(),
});
export type RunState = z.infer<typeof RunState>;

export function createState(args: {
  id: string;
  workflow: string;
  workflow_version: string;
  start: string;
  goal: { text: string; success_criteria: string[] };
  input: Record<string, unknown>;
  budget?: Partial<Budget>;
  now?: string;
  parent?: string | null;
  depth?: number;
}): RunState {
  const now = args.now ?? new Date().toISOString();
  return {
    run: {
      id: args.id,
      workflow: args.workflow,
      workflow_version: args.workflow_version,
      started_at: now,
      updated_at: now,
      status: "running",
      cursor: args.start,
      step: 0,
      parent: args.parent ?? null,
      depth: args.depth ?? 0,
      budget: Budget.parse(args.budget ?? {}),
      spent: { steps: 0, jev_calls: 0, jev_input_tokens: 0, agent_calls: 0, agent_input_tokens: 0, agent_output_tokens: 0, wall_ms: 0 },
      halt_reason: null,
    },
    goal: args.goal,
    input: args.input,
    facts: {},
    assessments: {},
    decisions: [],
    actions: [],
    last: { node: null, kind: null, outcome: null, error: null },
    history: [],
    human: null,
    output: null,
  };
}

/**
 * Resolve a dot path against the state. Facts unwrap to their value so specs can
 * say `facts.category` instead of `facts.category.value`.
 */
export function getPath(state: RunState, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = state;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (isFact(cur)) cur = cur.value;                 // facts.x.field reaches into the value
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && p === "last") { cur = cur[cur.length - 1]; continue; }
    cur = (cur as Record<string, unknown>)[p];
  }
  if (isFact(cur)) return cur.value;
  return cur;
}

export function isFact(v: unknown): v is Fact {
  return !!v && typeof v === "object" && "value" in v && "source" in v && "step" in v;
}
