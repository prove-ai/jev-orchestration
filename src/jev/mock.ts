/**
 * Two Jev stand-ins.
 *
 *  ScriptedJev  — tests: answers come from a script keyed by question id (or a function).
 *  HeuristicJev — demos without an API key: lexical overlap between the state and
 *                 each option/level/criterion description, softmaxed. It is not
 *                 smart; it exists so the tree, guards and live view can be exercised.
 */
import type { Answer, Jev, JevResponse, Question } from "./types.js";

export type Script = Record<string, Answer | ((state: unknown, q: Question) => Answer)>;

export class ScriptedJev implements Jev {
  public calls: Array<{ state: unknown; questions: Record<string, Question> }> = [];
  constructor(private readonly script: Script | ((state: unknown, q: Question, id: string) => Answer)) {}

  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
    this.calls.push({ state, questions });
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const entry = typeof this.script === "function" ? this.script(state, q, id) : this.script[id];
      if (!entry) throw new Error(`ScriptedJev: no script for question "${id}"`);
      answers[id] = typeof entry === "function" ? entry(state, q) : entry;
    }
    return { model: "jev-scripted", answers, usage: { input_tokens: JSON.stringify(state).length >> 2, output_tokens: 0 } };
  }
}

const STOP = new Set(["the", "a", "an", "is", "of", "to", "and", "or", "in", "on", "for", "it", "this", "that", "with", "as", "be", "are", "was", "by", "at", "not", "no", "yes", "true", "false", "customer", "user", "state", "request"]);

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, "");
}

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of b) if (a.has(w)) n++;
  return n;
}

function softmax(scores: number[], temp = 0.7): number[] {
  const m = Math.max(...scores);
  const ex = scores.map((s) => Math.exp((s - m) / temp));
  const z = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / z);
}

export class HeuristicJev implements Jev {
  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
    // Score against the evidence only (the view's declared context), not the goal or rubric labels.
    const ctx = state && typeof state === "object" && "context" in state ? (state as { context: unknown }).context : state;
    const text = typeof ctx === "string" ? ctx : strings(ctx).join(" ");
    const st = tokens(text);
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const scores = keys.map((k) => overlap(st, tokens(`${k} ${q.criteria[k]}`)));
        const p = softmax(scores);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, round(p[i])]));
        const best = keys[p.indexOf(Math.max(...p))];
        answers[id] = { type: "choice", choice: best, confidence: round(Math.max(...p)), probabilities };
      } else if (q.type === "noul") {
        const t = overlap(st, tokens(q.criteria.true));
        const f = overlap(st, tokens(q.criteria.false));
        const [pt] = softmax([t, f]);
        answers[id] = { type: "noul", noul: round(pt) };
      } else {
        const scores = q.criteria.map((lvl) => overlap(st, tokens(lvl)));
        const p = softmax(scores);
        const score = p.reduce((acc, pi, i) => acc + pi * i, 0);
        answers[id] = {
          type: "score",
          score: round(score),
          confidence: round(Math.max(...p)),
          legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])),
          probabilities: Object.fromEntries(p.map((pi, i) => [String(i), round(pi)])),
        };
      }
    }
    return { model: "jev-heuristic", answers, usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 0 } };
  }
}

/** Collect free-text values only; structured records (assessments, tool results) are not evidence for a word-overlap mock. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string") as string[];
  return [];
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }
