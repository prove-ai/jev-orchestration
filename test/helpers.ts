import type { WorkflowInput } from "../src/spec/workflow.js";
import type { Answer } from "../src/jev/types.js";

export const choice = (choice: string, confidence = 0.9, others: Record<string, number> = {}): Answer =>
  ({ type: "choice", choice, confidence, probabilities: { [choice]: confidence, ...others } });
export const noul = (p: number): Answer => ({ type: "noul", noul: p });
export const score = (probs: number[]): Answer => {
  const s = probs.reduce((a, p, i) => a + p * i, 0);
  return { type: "score", score: s, confidence: Math.max(...probs), legend: Object.fromEntries(probs.map((_, i) => [String(i), `L${i}`])), probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])) };
};

/** decide → (a: act → end_ok | b: end_fail), unsure → human */
export const tinyWorkflow: WorkflowInput = {
  name: "tiny",
  goal: { text: "test" },
  start: "pick",
  nodes: [
    { kind: "decide", id: "pick", instructions: "pick", reads: ["input.msg"], options: { a: { description: "A", next: "do_a" }, b: { description: "B", next: "fail" } }, min_confidence: 0.6, on_unsure: "ask" },
    { kind: "act", id: "do_a", tool: "echo", args: { text: "${input.msg}!", raw: "$input.n" }, store_as: "echoed", next: "ok", on_error: "fail" },
    { kind: "human", id: "ask", question: "which? ${input.msg}", options: ["a", "b"] },
    { kind: "end", id: "ok", outcome: "succeeded", output: "facts.echoed" },
    { kind: "end", id: "fail", outcome: "failed" },
  ],
};
