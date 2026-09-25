import { createHash, randomUUID } from "node:crypto";
import { createState, getPath, type Assessment, type Budget, type RunState } from "../spec/state.js";
import { checkRegistry, edgesOf, type Node, type ParallelBranch, type Workflow } from "../spec/workflow.js";
import type { Answer, ChoiceAnswer, Jev, NoulAnswer, Question, ScoreAnswer } from "../jev/types.js";
import { buildView } from "../jev/view.js";
import type { EventSink, RunEvent } from "./events.js";

export interface Meter { agent: string; model?: string; usage?: { input_tokens: number; output_tokens: number } }
export interface ToolContext { state: RunState; meter: (m: Meter) => void }
export type Tool = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;
export type CodeFn = (state: RunState) => void | { facts?: Record<string, unknown>; output?: unknown };

export interface EngineOptions {
  workflow: Workflow;
  jev: Jev;
  tools: Record<string, Tool>;
  code?: Record<string, CodeFn>;
  workflows?: Record<string, Workflow>;   // registry for sub / parallel nodes
  budget?: Partial<Budget>;
  onEvent?: EventSink;
  runId?: string;
  now?: () => number;
  /** internal: set when started by a sub/parallel node */
  parentRunId?: string;
  depth?: number;
  /** Internal shared call reservations for ancestor runs. */
  callBudgets?: Array<{ limit: number; used: number }>;
}

export class GuardHalt extends Error {}
class NeedsHuman extends Error {
  constructor(public human: RunState["human"], message: string) { super(message); }
}

export async function run(input: Record<string, unknown>, opts: EngineOptions): Promise<RunState> {
  const wf = opts.workflow;
  const now = opts.now ?? Date.now;
  const runId = opts.runId ?? randomUUID().slice(0, 8);
  const nodes = new Map<string, Node>(wf.nodes.map((n) => [n.id, n]));
  const depth = opts.depth ?? 0;
  if (depth === 0 && opts.workflows) checkRegistry({ ...opts.workflows, [wf.name]: wf });
  const state = createState({
    id: runId,
    workflow: wf.name,
    workflow_version: wf.version,
    start: wf.start,
    goal: wf.goal,
    input,
    budget: { ...wf.budget, ...opts.budget },
    now: new Date(now()).toISOString(),
    parent: opts.parentRunId ?? null,
    depth,
  });
  const callBudgets = [...(opts.callBudgets ?? []), { limit: state.run.budget.max_jev_calls, used: 0 }];
  const t0 = now();
  const visits = new Map<string, number>();
  const seenStates = new Set<string>();
  const emit = (e: RunEvent) => opts.onEvent?.(e);
  const stamp = () => new Date(now()).toISOString();
  const ev = <T extends RunEvent["type"]>(type: T, data: Omit<Extract<RunEvent, { type: T }>, "type" | "run_id" | "at">) =>
    emit({ type, run_id: runId, at: stamp(), ...data } as unknown as RunEvent);

  const touch = () => { state.run.updated_at = stamp(); state.run.spent.wall_ms = now() - t0; };
  const finish = (status: RunState["run"]["status"], reason: string | null) => {
    state.run.status = status;
    state.run.halt_reason = reason;
    touch();
    ev("state", { step: state.run.step, state: snapshot(state) });
    ev("run.end", { status, reason, spent: state.run.spent });
    return state;
  };

  ev("run.start", { workflow: wf.name, parent: state.run.parent, depth });
  if (depth > state.run.budget.max_depth) return finish("halted", `budget: max_depth ${state.run.budget.max_depth}`);
  ev("state", { step: 0, state: snapshot(state) });

  while (state.run.status === "running") {
    // ---- guards (code, never the model) -----------------------------------
    const b = state.run.budget;
    if (state.run.spent.steps >= b.max_steps) return finish("halted", `budget: max_steps ${b.max_steps}`);
    if (now() - t0 > b.max_wall_ms) return finish("halted", `budget: max_wall_ms ${b.max_wall_ms}`);
    const nodeId = state.run.cursor;
    const node = nodes.get(nodeId);
    if (!node) return finish("failed", `unknown node "${nodeId}"`);
    const v = (visits.get(nodeId) ?? 0) + 1;
    visits.set(nodeId, v);
    if (v > b.max_visits_per_node) return finish("halted", `loop: node "${nodeId}" visited ${v} times`);
    const sig = `${nodeId}|${fingerprint(state)}`;
    if (seenStates.has(sig) && node.kind !== "human" && node.kind !== "end") {
      return finish("halted", `loop: node "${nodeId}" re-entered with identical state`);
    }
    seenStates.add(sig);

    const step = state.run.step;
    ev("node.enter", { step, node: nodeId, kind: node.kind });

    let next: string | null = null;
    let label = "";
    let line = "";

    try {
      switch (node.kind) {
        case "decide": {
          if (state.run.spent.jev_calls >= b.max_jev_calls) return finish("halted", `budget: max_jev_calls ${b.max_jev_calls}`);
          const criteria = Object.fromEntries(Object.entries(node.options).map(([k, o]) => [k, o.description]));
          const questions: Record<string, Question> = {
            route: { type: "choice", instructions: node.instructions, criteria },
            ...extraQuestions(node.extra),
          };
          const { answers, latency, model, tokens } = await ask(node, questions);
          const a = answers.route as ChoiceAnswer;
          storeExtras(state, node.extra, answers, step);
          const unsure = a.confidence < node.min_confidence;
          state.facts[nodeId] = { value: unsure ? "unsure" : a.choice, source: "jev", step, at: stamp() };
          if (unsure) {
            label = "unsure";
            next = node.on_unsure ?? null;
          } else {
            label = a.choice;
            next = node.options[a.choice]?.next ?? null;
            if (!next) throw new Error(`jev chose unknown option "${a.choice}"`);
          }
          state.decisions.push({
            step, node: nodeId, mode: "choice", question: node.instructions, answer: a.choice,
            confidence: a.confidence, probabilities: a.probabilities, edge: label, next,
            escalated: unsure, latency_ms: latency, input_tokens: tokens, model,
          });
          line = unsure
            ? `unsure (${a.choice} @ ${pct(a.confidence)} < ${pct(node.min_confidence)})`
            : `chose ${a.choice} @ ${pct(a.confidence)}`;
          if (unsure && !next) {
            state.human = { node: nodeId, question: node.instructions, options: Object.keys(node.options) };
            pushHistory(state, step, nodeId, line + " → needs human");
            return finish("needs_human", `decide "${nodeId}": confidence ${a.confidence} below ${node.min_confidence}`);
          }
          break;
        }
        case "check": {
          if (state.run.spent.jev_calls >= b.max_jev_calls) return finish("halted", `budget: max_jev_calls ${b.max_jev_calls}`);
          const questions: Record<string, Question> = {
            check: { type: "noul", instructions: node.instructions, criteria: node.criteria },
            ...extraQuestions(node.extra),
          };
          const { answers, latency, model, tokens } = await ask(node, questions);
          const a = answers.check as NoulAnswer;
          storeExtras(state, node.extra, answers, step);
          const p = a.noul;
          const unsure = node.unsure_band > 0 && Math.abs(p - 0.5) + 1e-9 < node.unsure_band;
          if (unsure) { label = "unsure"; next = node.on_unsure ?? null; }
          else if (p >= node.threshold) { label = "true"; next = node.on_true; }
          else { label = "false"; next = node.on_false; }
          state.facts[nodeId] = { value: unsure ? "unsure" : label === "true", source: "jev", step, at: stamp() };
          state.decisions.push({
            step, node: nodeId, mode: "noul", question: node.instructions, answer: p,
            confidence: Math.abs(p - 0.5) * 2, probabilities: { true: p, false: 1 - p }, edge: label, next,
            escalated: unsure, latency_ms: latency, input_tokens: tokens, model,
          });
          line = `${label} (p=${p.toFixed(2)})`;
          if (unsure && !next) {
            state.human = { node: nodeId, question: node.instructions, options: ["true", "false"] };
            pushHistory(state, step, nodeId, line + " → needs human");
            return finish("needs_human", `check "${nodeId}": p=${p} inside unsure band`);
          }
          break;
        }
        case "assess": {
          if (state.run.spent.jev_calls >= b.max_jev_calls) return finish("halted", `budget: max_jev_calls ${b.max_jev_calls}`);
          const questions: Record<string, Question> = {
            assess: { type: "score", instructions: node.instructions, criteria: node.levels },
            ...extraQuestions(node.extra),
          };
          const { answers, latency, model, tokens } = await ask(node, questions);
          const a = answers.assess as ScoreAnswer;
          storeExtras(state, node.extra, answers, step);
          const as = toAssessment(a, node.levels, step);
          state.assessments[node.store_as] = as;
          state.decisions.push({
            step, node: nodeId, mode: "score", question: node.instructions, answer: a.score,
            confidence: a.confidence, probabilities: a.probabilities, edge: "stored", next: node.next,
            escalated: false, latency_ms: latency, input_tokens: tokens, model,
          });
          label = "next"; next = node.next;
          line = `${node.store_as} = L${as.level} "${as.label}" (score ${as.score.toFixed(2)}, ${pct(as.confidence)})`;
          break;
        }
        case "act": {
          const tool = opts.tools[node.tool];
          if (!tool) throw new Error(`tool "${node.tool}" is not registered`);
          const args = resolveArgs(node.args, state) as Record<string, unknown>;
          ev("tool.call", { step, node: nodeId, tool: node.tool, args });
          const ts = now();
          try {
            const result = await tool(args, toolCtx(nodeId));
            const dur = now() - ts;
            if (node.store_as) state.facts[node.store_as] = { value: result, source: "tool", step, at: stamp() };
            const summary = node.summary ? interpolate(node.summary, state) : summarize(result);
            state.actions.push({ step, node: nodeId, tool: node.tool, args, outcome: "ok", summary, error: null, duration_ms: dur });
            state.last = { node: nodeId, kind: "act", outcome: "ok", error: null };
            ev("tool.result", { step, node: nodeId, tool: node.tool, outcome: "ok", summary, duration_ms: dur });
            label = "ok"; next = node.next; line = `${node.tool} ok: ${summary}`;
          } catch (e) {
            const dur = now() - ts;
            const msg = e instanceof Error ? e.message : String(e);
            state.actions.push({ step, node: nodeId, tool: node.tool, args, outcome: "error", summary: "", error: msg, duration_ms: dur });
            state.last = { node: nodeId, kind: "act", outcome: "error", error: msg };
            ev("tool.result", { step, node: nodeId, tool: node.tool, outcome: "error", summary: msg, duration_ms: dur });
            line = `${node.tool} error: ${msg}`;
            if (!node.on_error) {
              pushHistory(state, step, nodeId, line);
              return finish("failed", `tool "${node.tool}" failed at "${nodeId}": ${msg}`);
            }
            label = "error"; next = node.on_error;
          }
          break;
        }
        case "code": {
          const fn = opts.code?.[node.fn];
          if (!fn) throw new Error(`code fn "${node.fn}" is not registered`);
          const out = fn(state);
          if (out?.facts) for (const [k, v] of Object.entries(out.facts)) state.facts[k] = { value: v, source: "code", step, at: stamp() };
          if (out && "output" in out) state.output = out.output;
          state.last = { node: nodeId, kind: "code", outcome: "ok", error: null };
          label = "next"; next = node.next;
          line = out?.facts ? `set ${Object.keys(out.facts).join(", ")}` : "ran";
          break;
        }
        case "switch": {
          const value = getPath(state, node.on);
          const key = value === undefined || value === null ? "" : String(value);
          if (Object.hasOwn(node.cases, key)) { label = key; next = node.cases[key]; }
          else { label = "default"; next = node.default; }
          line = `${node.on} = ${JSON.stringify(value)} → ${label}`;
          break;
        }
        case "sub": {
          const input = resolveArgs(node.input, state) as Record<string, unknown>;
          const childId = `${runId}.${nodeId}${v > 1 ? `#${v}` : ""}`;
          ev("tool.call", { step, node: nodeId, tool: `workflow:${node.workflow}`, args: input });
          const ts = now();
          const child = await runChild(node.workflow, input, childId);
          const dur = now() - ts;
          const ok = child.run.status === "succeeded";
          const summary = ok ? (node.summary ? interpolate(node.summary, state) : summarize(child.output)) : "";
          state.actions.push({ step, node: nodeId, tool: `workflow:${node.workflow}`, args: input, outcome: ok ? "ok" : "error", summary, error: ok ? null : child.run.halt_reason, duration_ms: dur });
          ev("tool.result", { step, node: nodeId, tool: `workflow:${node.workflow}`, outcome: ok ? "ok" : "error", summary: ok ? summary : child.run.halt_reason ?? child.run.status, duration_ms: dur });
          if (child.run.status === "needs_human") {
            state.human = child.human;
            pushHistory(state, step, nodeId, `sub ${node.workflow} needs human`);
            return finish("needs_human", `sub "${nodeId}" (${childId}): ${child.run.halt_reason}`);
          }
          if (ok) {
            state.facts[node.store_as] = { value: child.output, source: "tool", step, at: stamp() };
            state.last = { node: nodeId, kind: "sub", outcome: "ok", error: null };
            label = "ok"; next = node.next; line = `sub ${node.workflow} ok: ${summary}`;
          } else {
            const msg = `${child.run.status}: ${child.run.halt_reason}`;
            state.last = { node: nodeId, kind: "sub", outcome: "error", error: msg };
            line = `sub ${node.workflow} ${msg}`;
            if (!node.on_error) { pushHistory(state, step, nodeId, line); return finish("failed", `sub "${nodeId}" ${msg}`); }
            label = "error"; next = node.on_error;
          }
          if (overBudget()) return finish("halted", overBudget()!);
          break;
        }
        case "parallel": {
          const ts = now();
          const settled = await Promise.allSettled(node.branches.map((b) => runBranch(b, nodeId, step, v)));
          const dur = now() - ts;
          const results: Record<string, unknown> = {};
          const errors: string[] = [];
          let humanRequest: NeedsHuman | undefined;
          let guard: GuardHalt | undefined;
          node.branches.forEach((b, i) => {
            const r = settled[i];
            const toolName = b.kind === "act" ? b.tool : `workflow:${b.workflow}`;
            const args = (b.kind === "act" ? resolveArgs(b.args, state) : resolveArgs(b.input, state)) as Record<string, unknown>;
            if (r.status === "fulfilled") {
              results[b.id] = r.value;
              state.actions.push({ step, node: `${nodeId}/${b.id}`, tool: toolName, args, outcome: "ok", summary: summarize(r.value), error: null, duration_ms: dur });
            } else {
              if (r.reason instanceof NeedsHuman) humanRequest ??= r.reason;
              if (r.reason instanceof GuardHalt) guard ??= r.reason;
              const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
              errors.push(`${b.id}: ${msg}`);
              state.actions.push({ step, node: `${nodeId}/${b.id}`, tool: toolName, args, outcome: "error", summary: "", error: msg, duration_ms: dur });
            }
          });
          state.facts[node.store_as] = { value: results, source: "tool", step, at: stamp() };
          if (humanRequest) {
            state.human = humanRequest.human;
            pushHistory(state, step, nodeId, humanRequest.message);
            return finish("needs_human", humanRequest.message);
          }
          if (guard) throw guard;
          if (errors.length === 0) {
            state.last = { node: nodeId, kind: "parallel", outcome: "ok", error: null };
            label = "ok"; next = node.next; line = `parallel ok: ${Object.keys(results).join(", ")}`;
          } else {
            const msg = errors.join("; ");
            state.last = { node: nodeId, kind: "parallel", outcome: "error", error: msg };
            line = `parallel ${Object.keys(results).length}/${node.branches.length} ok; ${msg}`;
            if (!node.on_error) { pushHistory(state, step, nodeId, line); return finish("failed", `parallel "${nodeId}": ${msg}`); }
            label = "error"; next = node.on_error;
          }
          ev("tool.result", { step, node: nodeId, tool: "parallel", outcome: errors.length ? "error" : "ok", summary: line, duration_ms: dur });
          if (overBudget()) return finish("halted", overBudget()!);
          break;
        }
        case "human": {
          state.human = { node: nodeId, question: interpolate(node.question, state), options: node.options };
          pushHistory(state, step, nodeId, `needs human: ${state.human.question}`);
          return finish("needs_human", `human "${nodeId}"`);
        }
        case "end": {
          if (node.output) state.output = getPath(state, node.output);
          pushHistory(state, step, nodeId, `end ${node.outcome}`);
          state.run.spent.steps++;
          return finish(node.outcome, null);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushHistory(state, step, nodeId, `error: ${msg}`);
      return finish(e instanceof GuardHalt ? "halted" : "failed", `node "${nodeId}": ${msg}`);
    }

    pushHistory(state, step, nodeId, line);
    if (!next) return finish("failed", `node "${nodeId}" produced no next node`);
    ev("edge", { step, from: nodeId, label, to: next });
    state.run.cursor = next;
    state.run.step++;
    state.run.spent.steps++;
    touch();
    ev("state", { step: state.run.step, state: snapshot(state) });
  }
  return state;

  // ---- helpers ------------------------------------------------------------
  function toolCtx(nodeId: string): ToolContext {
    return {
      state,
      meter: (m) => {
        state.run.spent.agent_calls++;
        state.run.spent.agent_input_tokens += m.usage?.input_tokens ?? 0;
        state.run.spent.agent_output_tokens += m.usage?.output_tokens ?? 0;
        ev("agent", { step: state.run.step, node: nodeId, agent: m.agent, model: m.model ?? null, usage: m.usage ?? null });
      },
    };
  }

  function overBudget(): string | null {
    const b = state.run.budget, s = state.run.spent;
    if (s.jev_calls > b.max_jev_calls) return `budget: max_jev_calls ${b.max_jev_calls}`;
    if (s.jev_input_tokens > b.max_jev_input_tokens) return `budget: max_jev_input_tokens ${b.max_jev_input_tokens}`;
    return null;
  }

  /** Run a registered workflow as a child; child spend is folded into this run. */
  async function runChild(name: string, input: Record<string, unknown>, childId: string): Promise<RunState> {
    const child = opts.workflows?.[name];
    if (!child) throw new Error(`workflow "${name}" is not registered`);
    const cs = await run(input, {
      ...opts,
      workflow: child,
      runId: childId,
      parentRunId: runId,
      depth: depth + 1,
      budget: { ...child.budget, max_depth: state.run.budget.max_depth },
      callBudgets,
    });
    const sp = state.run.spent, c = cs.run.spent;
    sp.jev_calls += c.jev_calls; sp.jev_input_tokens += c.jev_input_tokens;
    sp.agent_calls += c.agent_calls; sp.agent_input_tokens += c.agent_input_tokens; sp.agent_output_tokens += c.agent_output_tokens;
    if (cs.run.status === "halted" && /budget: max_jev_(calls|input_tokens)/.test(cs.run.halt_reason ?? "")) {
      throw new GuardHalt(cs.run.halt_reason!);
    }
    return cs;
  }

  async function runBranch(b: ParallelBranch, nodeId: string, step: number, visit: number): Promise<unknown> {
    if (b.kind === "act") {
      const tool = opts.tools[b.tool];
      if (!tool) throw new Error(`tool "${b.tool}" is not registered`);
      const args = resolveArgs(b.args, state) as Record<string, unknown>;
      ev("tool.call", { step, node: `${nodeId}/${b.id}`, tool: b.tool, args });
      return tool(args, toolCtx(`${nodeId}/${b.id}`));
    }
    const input = resolveArgs(b.input, state) as Record<string, unknown>;
    const childId = `${runId}.${nodeId}.${b.id}${visit > 1 ? `#${visit}` : ""}`;
    ev("tool.call", { step, node: `${nodeId}/${b.id}`, tool: `workflow:${b.workflow}`, args: input });
    const cs = await runChild(b.workflow, input, childId);
    if (cs.run.status === "needs_human") throw new NeedsHuman(cs.human, `workflow ${b.workflow} needs human: ${cs.human?.question ?? cs.run.halt_reason}`);
    if (cs.run.status !== "succeeded") throw new Error(`workflow ${b.workflow} ${cs.run.status}: ${cs.run.halt_reason ?? (cs.human ? `needs human: ${cs.human.question}` : "")}`);
    return cs.output;
  }

  async function ask(node: Extract<Node, { kind: "decide" | "check" | "assess" }>, questions: Record<string, Question>) {
    const view = buildView(state, { reads: node.reads });
    ev("jev.ask", { step: state.run.step, node: node.id, questions: Object.keys(questions), view });
    const ts = now();
    // Reserve synchronously across all ancestors before starting asynchronous work.
    const exhausted = callBudgets.find((b) => b.used >= b.limit);
    if (exhausted) throw new GuardHalt(`budget: max_jev_calls ${exhausted.limit}`);
    for (const b of callBudgets) b.used++;
    state.run.spent.jev_calls++;
    const res = await opts.jev.ask(view, questions);
    const latency = now() - ts;
    const tokens = res.usage?.input_tokens ?? null;
    state.run.spent.jev_input_tokens += tokens ?? 0;
    ev("jev.answer", { step: state.run.step, node: node.id, answers: res.answers, latency_ms: latency, model: res.model });
    if (state.run.spent.jev_input_tokens > state.run.budget.max_jev_input_tokens) {
      throw new GuardHalt(`budget: max_jev_input_tokens ${state.run.budget.max_jev_input_tokens}`);
    }
    return { answers: res.answers, latency, model: res.model, tokens };
  }
}

function extraQuestions(extra: Extract<Node, { kind: "decide" }>["extra"]): Record<string, Question> {
  if (!extra) return {};
  const out: Record<string, Question> = {};
  for (const [id, q] of Object.entries(extra)) {
    out[`x:${id}`] = q.type === "noul"
      ? { type: "noul", instructions: q.instructions, criteria: q.criteria }
      : { type: "score", instructions: q.instructions, criteria: q.levels };
  }
  return out;
}

function storeExtras(state: RunState, extra: Extract<Node, { kind: "decide" }>["extra"], answers: Record<string, Answer>, step: number) {
  if (!extra) return;
  for (const [id, q] of Object.entries(extra)) {
    const a = answers[`x:${id}`];
    if (!a) continue;
    if (a.type === "noul") state.facts[id] = { value: a.noul, source: "jev", step, at: state.run.updated_at };
    else if (a.type === "score" && q.type === "score") state.assessments[id] = toAssessment(a, q.levels, step);
  }
}

function toAssessment(a: ScoreAnswer, levels: string[], step: number): Assessment {
  const entries = Object.entries(a.probabilities);
  const best = entries.reduce((m, e) => (e[1] > m[1] ? e : m), entries[0] ?? ["0", 0]);
  const level = Number(best[0]);
  return { level, label: a.legend?.[String(level)] ?? levels[level] ?? String(level), score: a.score, confidence: a.confidence, probabilities: a.probabilities, step };
}

/** "$path" → raw value; "${path}" inside a string → interpolated; recurses into objects/arrays. */
export function resolveArgs(v: unknown, state: RunState): unknown {
  if (typeof v === "string") {
    if (/^\$[A-Za-z_][\w.]*$/.test(v)) return getPath(state, v.slice(1));
    return interpolate(v, state);
  }
  if (Array.isArray(v)) return v.map((x) => resolveArgs(x, state));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveArgs(x, state)]));
  return v;
}

export function interpolate(tpl: string, state: RunState): string {
  return tpl.replace(/\$\{([\w.]+)\}/g, (_, p) => {
    const val = getPath(state, p);
    return typeof val === "string" ? val : val === undefined ? "" : JSON.stringify(val);
  });
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "done";
  const s = typeof result === "string" ? result : JSON.stringify(result);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

function pushHistory(state: RunState, step: number, node: string, line: string) {
  state.history.push({ step, node, line });
}

/** Content-only fingerprint: fact values, assessment levels, output, last outcome. Timestamps and step numbers excluded. */
function fingerprint(state: RunState): string {
  const f = Object.fromEntries(Object.entries(state.facts).map(([k, v]) => [k, v.value]));
  const a = Object.fromEntries(Object.entries(state.assessments).map(([k, v]) => [k, [v.level, v.score]]));
  return createHash("sha1").update(JSON.stringify({ f, a, o: state.output, l: [state.last.node, state.last.outcome, state.last.error] })).digest("hex").slice(0, 16);
}

function snapshot(state: RunState): RunState { return structuredClone(state); }
function pct(n: number): string { return `${Math.round(n * 100)}%`; }

export { edgesOf };
