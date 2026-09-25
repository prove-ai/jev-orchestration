/**
 * Baseline for the benchmark: the same `Jev` interface, answered by a generative model.
 *
 * This is the LangGraph-style router: Claude reads the state view and the questions,
 * and returns the branch / probability / rubric level as JSON. Everything else in the
 * engine is identical, so the comparison isolates the decision layer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Answer, Jev, JevResponse, Question } from "./types.js";

export interface ClaudeRouterOptions {
  model?: string;                        // default claude-opus-5
  effort?: "low" | "medium" | "high";    // default low: routers are not asked to deliberate
  maxTokens?: number;
  client?: Anthropic;
}

const SYSTEM = `You are a routing model inside an agent workflow. You receive a STATE document and one or more QUESTIONS.
Answer every question and reply with a single JSON object keyed by question id, nothing else.

Answer shapes:
- choice: {"choice": "<option key>", "confidence": <0..1>, "probabilities": {"<key>": <p>, ...}}  (probabilities over ALL option keys, summing to 1; confidence = probability of the chosen key)
- noul:   {"noul": <0..1 probability that the statement is TRUE>}
- score:  {"probabilities": {"0": <p>, "1": <p>, ...}}  (over ALL level indices, summing to 1)

Be calibrated: when the state does not support a confident answer, spread the probability.`;

export class ClaudeRouter implements Jev {
  private readonly client: Anthropic;
  readonly model: string;
  private readonly effort: NonNullable<ClaudeRouterOptions["effort"]>;
  private readonly maxTokens: number;

  constructor(opts: ClaudeRouterOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5";
    this.effort = opts.effort ?? "low";
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
    const prompt = `STATE:\n${JSON.stringify(state, null, 1)}\n\nQUESTIONS:\n${JSON.stringify(questions, null, 1)}\n\nReply with the JSON object only.`;
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM,
      output_config: { effort: this.effort },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new Error(`router refused: ${res.stop_details?.explanation ?? "no detail"}`);
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const raw = parseJson(text);
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = raw[id];
      if (!a || typeof a !== "object") throw new Error(`router answer missing for "${id}": ${text.slice(0, 200)}`);
      answers[id] = normalize(q, a as Record<string, unknown>);
    }
    return { model: res.model, answers, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
  }
}

function parseJson(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`router returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]) as Record<string, unknown>;
}

/** Coerce a model-written answer into the exact Jev answer shape (renormalized, argmax-consistent). */
export function normalize(q: Question, a: Record<string, unknown>): Answer {
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    let probs = numMap(a.probabilities, keys);
    if (!probs) {
      const c = String(a.choice ?? keys[0]);
      const conf = clamp(Number(a.confidence ?? 1));
      probs = Object.fromEntries(keys.map((k) => [k, k === c ? conf : (1 - conf) / Math.max(1, keys.length - 1)]));
    }
    const best = keys.reduce((m, k) => (probs![k] > probs![m] ? k : m), keys[0]);
    const choice = keys.includes(String(a.choice)) && probs[String(a.choice)] === probs[best] ? String(a.choice) : best;
    return { type: "choice", choice, confidence: round(probs[choice]), probabilities: mapRound(probs) };
  }
  if (q.type === "noul") {
    return { type: "noul", noul: round(clamp(Number(a.noul ?? a.probability ?? a.p ?? 0.5))) };
  }
  const idx = q.criteria.map((_, i) => String(i));
  let probs = numMap(a.probabilities, idx);
  if (!probs) {
    const lvl = Math.min(idx.length - 1, Math.max(0, Math.round(Number(a.level ?? a.score ?? 0))));
    probs = Object.fromEntries(idx.map((i) => [i, Number(i) === lvl ? 1 : 0]));
  }
  const score = idx.reduce((acc, i) => acc + probs![i] * Number(i), 0);
  const best = idx.reduce((m, i) => (probs![i] > probs![m] ? i : m), idx[0]);
  return { type: "score", score: round(score), confidence: round(probs[best]), legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])), probabilities: mapRound(probs) };
}

function numMap(v: unknown, keys: string[]): Record<string, number> | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const k of keys) { const n = Math.max(0, Number(src[k] ?? 0)); out[k] = Number.isFinite(n) ? n : 0; sum += out[k]; }
  if (sum <= 0) return null;
  for (const k of keys) out[k] /= sum;
  return out;
}
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
const round = (n: number) => Math.round(n * 1000) / 1000;
const mapRound = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));
