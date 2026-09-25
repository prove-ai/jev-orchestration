import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView } from "../src/jev/view.js";
import { createState } from "../src/spec/state.js";

function st() {
  const s = createState({ id: "r", workflow: "w", workflow_version: "1", start: "x", goal: { text: "goal", success_criteria: ["c1"] }, input: { message: "hi", secret: "s3cr3t" } });
  s.facts.category = { value: "billing", source: "jev", step: 1, at: "" };
  s.assessments.urgency = { level: 2, label: "Blocking", score: 1.9, confidence: 0.7, probabilities: { "2": 0.7 }, step: 0 };
  for (let i = 0; i < 12; i++) s.history.push({ step: i, node: `n${i}`, line: `line ${i}` });
  return s;
}

test("reads select exactly the declared paths; facts unwrap; history tail is bounded", () => {
  const v = buildView(st(), { reads: ["input.message", "facts.category", "assessments.urgency.label"] });
  assert.deepEqual(v.context, { "input.message": "hi", "facts.category": "billing", "assessments.urgency.label": "Blocking" });
  assert.equal(v.recent.length, 8);
  assert.equal(v.recent[0], "#4 n4: line 4");
  assert.equal(v.goal.text, "goal");
  assert.ok(!JSON.stringify(v).includes("s3cr3t"), "undeclared input must not leak");
});

test("no reads → all input, facts and assessments", () => {
  const v = buildView(st());
  assert.deepEqual(Object.keys(v.context), ["input.message", "input.secret", "facts.category", "assessments.urgency"]);
});

test("oversized views are trimmed to the char budget", () => {
  const s = st();
  s.facts.blob = { value: "x".repeat(50_000), source: "tool", step: 1, at: "" };
  const v = buildView(s, { reads: ["facts.blob", "input.message"], maxChars: 2_000 });
  assert.ok(JSON.stringify(v).length < 3_000);
  assert.match(String(v.context["facts.blob"]), /truncated/);
});
