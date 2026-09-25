/**
 * Build the `state` document sent to Jev for one node.
 *
 * Only what the node declares in `reads` goes in, plus the goal, the last
 * outcome and a short history tail. This is what keeps calls small and makes the
 * live view honest: the reader can see exactly what the decision was based on.
 */
import { getPath, type RunState } from "../spec/state.js";

export interface ViewOptions {
  reads?: string[];
  historyTail?: number;       // default 8
  maxChars?: number;          // default 60_000 (~15k tokens; Jev caps state at 32k tokens)
}

export interface JevView {
  goal: { text: string; success_criteria: string[] };
  step: number;
  context: Record<string, unknown>;
  last: RunState["last"];
  recent: string[];
}

export function buildView(state: RunState, opts: ViewOptions = {}): JevView {
  const tail = opts.historyTail ?? 8;
  const maxChars = opts.maxChars ?? 60_000;
  const reads = opts.reads && opts.reads.length ? opts.reads : defaultReads(state);

  const context: Record<string, unknown> = {};
  for (const path of reads) {
    if (path === "history") continue;
    context[path] = getPath(state, path);
  }

  let view: JevView = {
    goal: state.goal,
    step: state.run.step,
    context,
    last: state.last,
    recent: state.history.slice(-tail).map((h) => `#${h.step} ${h.node}: ${h.line}`),
  };

  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive safe integer");
  }
  if (size(view) > maxChars) view = { ...view, recent: [] };
  if (size(view) > maxChars) {
    // Preserve the goal and outcome: silently cutting these can change a decision.
    const base = { ...view, context: {} };
    if (size(base) > maxChars) throw new RangeError("Jev view goal and last outcome exceed maxChars");
    let low = 0, high = maxChars;
    let best: Record<string, unknown> = {};
    while (low <= high) {
      const budgetPer = Math.floor((low + high) / 2);
      const candidate = Object.fromEntries(Object.entries(context).map(([k, v]) => [k, truncate(v, budgetPer)]));
      if (size({ ...base, context: candidate }) <= maxChars) {
        best = candidate;
        low = budgetPer + 1;
      } else high = budgetPer - 1;
    }
    // Keep every declared key; reject when even keys and truncation markers cannot fit.
    if (Object.keys(best).length !== Object.keys(context).length) {
      throw new RangeError("Jev view context keys exceed maxChars");
    }
    view.context = best;
  }
  return view;
}

function defaultReads(state: RunState): string[] {
  return [
    ...Object.keys(state.input).map((k) => `input.${k}`),
    ...Object.keys(state.facts).map((k) => `facts.${k}`),
    ...Object.keys(state.assessments).map((k) => `assessments.${k}`),
  ];
}

function size(v: unknown): number { return JSON.stringify(v).length; }

function truncate(v: unknown, max: number): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined || s.length <= max) return v;
  return s.slice(0, max) + `…[truncated ${s.length - max} chars]`;
}
