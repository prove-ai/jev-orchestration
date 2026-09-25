/**
 * npm run bench -- [--routers jev,claude-opus-5,claude-sonnet-5] [--only triage|draft] [--concurrency 4]
 * npm run bench -- --rescore .jev/bench/<file>.json     # re-score saved predictions, no API calls
 *
 * Same workflows, same tools, same labeled inputs; only the decision layer changes.
 * Scores: decision accuracy vs hand labels, latency per decision, cost per decision.
 * Writes .jev/bench/<timestamp>.json with every prediction.
 */
try { process.loadEnvFile(".env"); } catch { /* env may be set in the shell */ }
for (const k of ["JEV_API_KEY", "JEV_BASE_URL", "JEV_MODEL", "ANTHROPIC_API_KEY"]) if (process.env[k] === "") delete process.env[k];

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { run } from "../src/runtime/engine.js";
import { jevFromEnv } from "../src/jev/client.js";
import { ClaudeRouter } from "../src/jev/claude-router.js";
import { buildView } from "../src/jev/view.js";
import { createState } from "../src/spec/state.js";
import type { Jev, JevResponse, Question } from "../src/jev/types.js";
import { example as triage } from "../examples/support-triage.js";
import { makeExample } from "../examples/research-review.js";
import { triageCases, draftCases } from "./cases.js";

// ---- pricing, USD per 1M tokens (2026-09) -----------------------------------
const PRICES: Array<[prefix: string, input: number, output: number]> = [
  ["jev", 0.042, 0],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4", 5, 25],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4-5", 1, 5],
];
function cost(model: string, inTok: number, outTok: number): number {
  const p = PRICES.find(([pre]) => model.startsWith(pre));
  if (!p) return NaN;
  return (inTok * p[1] + outTok * p[2]) / 1e6;
}

// ---- metered router wrapper -------------------------------------------------
interface Call { model: string; latency_ms: number; input_tokens: number; output_tokens: number; questions: string[] }
class Metered implements Jev {
  calls: Call[] = [];
  constructor(private inner: Jev) {}
  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
    const t = Date.now();
    const res = await this.inner.ask(state, questions);
    this.calls.push({ model: res.model, latency_ms: Date.now() - t, input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0, questions: Object.keys(questions) });
    return res;
  }
}

function makeRouter(name: string): Jev {
  if (name === "jev") return jevFromEnv();
  const m = name.match(/^claude[:-](.+)$/);
  if (m) return new ClaudeRouter({ model: m[1].startsWith("claude-") ? m[1] : `claude-${m[1]}` });
  throw new Error(`unknown router "${name}" (use jev or claude-<model>)`);
}

interface TriagePred { id: string; urgency: number | null; category: string | null; refund: boolean | null; outcome: string; status: string }
interface DraftPred { id: string; complete_p: number; quality_level: number | null; quality_score: number | null }

// ---- runner -----------------------------------------------------------------
const args = parse(process.argv.slice(2));
const rescore = args.rescore ? JSON.parse(readFileSync(String(args.rescore), "utf8")) as { routers: Record<string, { model: string; triage: TriagePred[]; draft: DraftPred[]; calls: Call[] }> } : null;
const routers = rescore ? Object.keys(rescore.routers) : String(args.routers ?? "jev,claude-opus-5").split(",").map((s) => s.trim()).filter(Boolean);
const only = args.only ? String(args.only) : null;
const concurrency = Number(args.concurrency ?? 4);

const research = makeExample("mock");
const draftLoop = research.workflows["draft-loop"];
const completeNode = draftLoop.nodes.find((n) => n.id === "complete");
const qualityNode = research.main.nodes.find((n) => n.id === "quality");
if (completeNode?.kind !== "check" || qualityNode?.kind !== "assess") throw new Error("example nodes changed");

const report: Record<string, unknown> = { at: new Date().toISOString(), routers: {} };
const summaryRows: Array<Record<string, string | number>> = [];

const preds: Record<string, { triage: TriagePred[]; draft: DraftPred[] }> = {};
for (const name of routers) {
  const saved = rescore?.routers[name];
  const metered = new Metered(saved ? { ask: async () => { throw new Error("rescore"); } } : makeRouter(name));
  if (saved) metered.calls = saved.calls;
  console.log(`\n== ${name}${saved ? " (rescored)" : ""} ==`);

  // -- triage: full workflow runs, mock tools --
  const triagePreds: TriagePred[] = saved ? saved.triage : [];
  let triageFailures = 0;
  if (!saved && only !== "draft") {
    await pool(triageCases, concurrency, async (c) => {
      const jevCalls = metered.calls.length;
      try {
        const s = await run({ message: c.message, customer_id: c.customer_id }, { workflow: triage.main, workflows: triage.workflows, jev: metered, tools: triage.tools, code: triage.code });
        const f = (k: string) => s.facts[k]?.value;
        const outcome = s.run.status === "needs_human" ? "human" : f("refund") ? "refund" : f("page") ? "page" : f("ticket") ? "ticket" : s.run.status;
        triagePreds.push({ id: c.id, urgency: s.assessments.urgency?.level ?? null, category: (f("category") as string | undefined) ?? null, refund: typeof f("wants_refund") === "boolean" ? (f("wants_refund") as boolean) : null, outcome, status: s.run.status });
      } catch (e) {
        triageFailures++;
        triagePreds.push({ id: c.id, urgency: null, category: null, refund: null, outcome: `error: ${(e as Error).message.slice(0, 80)}`, status: "error" });
      }
      process.stdout.write(`  ${c.id} ${(metered.calls.length - jevCalls)} calls\n`);
    });
  }

  // -- draft: the two research decisions, asked directly on fixed drafts --
  const draftPreds: DraftPred[] = saved ? saved.draft : [];
  if (!saved && only !== "triage") {
    await pool(draftCases, concurrency, async (c) => {
      const st = createState({ id: c.id, workflow: "bench", workflow_version: "1", start: "x", goal: draftLoop.goal, input: { topic: c.topic }, });
      st.facts.draft = { value: c.draft, source: "tool", step: 0, at: "" };
      const completeView = buildView(st, { reads: completeNode.reads });
      const qualityView = buildView({ ...st, goal: research.main.goal }, { reads: qualityNode.reads });
      let complete_p = NaN, level: number | null = null, score: number | null = null;
      try {
        const r1 = await metered.ask(completeView, { check: { type: "noul", instructions: completeNode.instructions, criteria: completeNode.criteria } });
        const a1 = r1.answers.check; if (a1.type === "noul") complete_p = a1.noul;
        const r2 = await metered.ask(qualityView, { assess: { type: "score", instructions: qualityNode.instructions, criteria: qualityNode.levels } });
        const a2 = r2.answers.assess;
        if (a2.type === "score") { const e = Object.entries(a2.probabilities).sort((x, y) => y[1] - x[1])[0]; level = Number(e[0]); score = a2.score; }
      } catch (e) { process.stdout.write(`  ${c.id} error ${(e as Error).message.slice(0, 80)}\n`); }
      draftPreds.push({ id: c.id, complete_p, quality_level: level, quality_score: score });
      process.stdout.write(`  ${c.id} done\n`);
    });
  }

  // -- score --
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const tp = byId(triagePreds), dp = byId(draftPreds);
  let catOk = 0, catN = 0, urgOk = 0, urg1 = 0, refOk = 0, refN = 0, outOk = 0;
  for (const c of triageCases) {
    const p = tp.get(c.id); if (!p) continue;
    if (c.outcome !== "page") { catN++; if (p.category === c.category) catOk++; }   // category is only asked below critical urgency
    if (p.urgency === c.urgency) urgOk++;
    if (p.urgency !== null && Math.abs(p.urgency - c.urgency) <= 1) urg1++;
    if (c.refund !== null) { refN++; if (p.refund === c.refund) refOk++; }
    if (p.outcome === c.outcome) outOk++;
  }
  let compOk = 0, qOk = 0, q1 = 0;
  for (const c of draftCases) {
    const p = dp.get(c.id); if (!p) continue;
    if (Number.isFinite(p.complete_p) && (p.complete_p >= completeNode.threshold) === c.complete) compOk++;
    if (p.quality_level === c.quality) qOk++;
    if (p.quality_level !== null && Math.abs(p.quality_level - c.quality) <= 1) q1++;
  }
  const lat = metered.calls.map((c) => c.latency_ms).sort((a, b) => a - b);
  const inTok = metered.calls.reduce((a, c) => a + c.input_tokens, 0);
  const outTok = metered.calls.reduce((a, c) => a + c.output_tokens, 0);
  const model = metered.calls[0]?.model ?? name;
  const usd = cost(model, inTok, outTok);
  const nT = only === "draft" ? 0 : triageCases.length, nD = only === "triage" ? 0 : draftCases.length;
  const row = {
    router: name, model,
    "category": pct(acc(catOk, catN)), "urgency": pct(acc(urgOk, nT)), "urgency±1": pct(acc(urg1, nT)), "refund": pct(acc(refOk, refN)), "outcome": pct(acc(outOk, nT)),
    "complete": pct(acc(compOk, nD)), "quality": pct(acc(qOk, nD)), "quality±1": pct(acc(q1, nD)),
    calls: metered.calls.length, "p50 ms": lat[Math.floor(lat.length / 2)] ?? 0, "p95 ms": lat[Math.floor(lat.length * 0.95)] ?? 0, "mean ms": Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length)),
    "tokens in/out": `${inTok}/${outTok}`, "USD total": usd.toFixed(4), "USD/decision": (usd / Math.max(1, metered.calls.length)).toFixed(5),
    failures: triageFailures,
  };
  preds[name] = { triage: triagePreds, draft: draftPreds };
  summaryRows.push(row);
  (report.routers as Record<string, unknown>)[name] = { model, triage: triagePreds, draft: draftPreds, calls: metered.calls, summary: row };
}

// ---- agreement between routers (independent of labels) --------------------
const base = routers[0];
if (routers.length > 1 && preds[base]) {
  console.log(`\n== agreement with ${base} (same answer, regardless of label) ==`);
  const bt = new Map(preds[base].triage.map((p) => [p.id, p])), bd = new Map(preds[base].draft.map((p) => [p.id, p]));
  for (const name of routers.slice(1)) {
    let cat = 0, urg = 0, out = 0, n = 0, comp = 0, q = 0, m = 0;
    for (const p of preds[name].triage) { const b = bt.get(p.id); if (!b) continue; n++; if (p.category === b.category) cat++; if (p.urgency === b.urgency) urg++; if (p.outcome === b.outcome) out++; }
    for (const p of preds[name].draft) { const b = bd.get(p.id); if (!b) continue; m++; if ((p.complete_p >= 0.5) === (b.complete_p >= 0.5)) comp++; if (p.quality_level === b.quality_level) q++; }
    console.log(`  ${name.padEnd(16)} category ${pct(acc(cat, n))}  urgency ${pct(acc(urg, n))}  outcome ${pct(acc(out, n))}  complete ${pct(acc(comp, m))}  quality ${pct(acc(q, m))}`);
  }
}
function acc(n: number, d: number): number { return d ? n / d : NaN; }

// ---- print ------------------------------------------------------------------
console.log("\n== results ==  (labels: bench/cases.ts; triage n=" + triageCases.length + ", draft n=" + draftCases.length + ")\n");
const cols = Object.keys(summaryRows[0]);
const widths = cols.map((c) => Math.max(c.length, ...summaryRows.map((r) => String(r[c]).length)));
console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of summaryRows) console.log(cols.map((c, i) => String(r[c]).padEnd(widths[i])).join("  "));

if (!rescore) {
  mkdirSync(".jev/bench", { recursive: true });
  const out = `.jev/bench/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\nwrote ${out}  (re-score later with: npm run bench -- --rescore ${out})`);
}

// ---- utils ------------------------------------------------------------------
function pct(x: number): string { return Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-"; }
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("--")) continue;
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) { out[a.slice(2)] = v; i++; } else out[a.slice(2)] = true;
  }
  return out;
}
