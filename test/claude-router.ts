import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/jev/claude-router.js";

const choiceQ = { type: "choice" as const, instructions: "", criteria: { a: "A", b: "B", c: "C" } };
const scoreQ = { type: "score" as const, instructions: "", criteria: ["low", "mid", "high"] };
const noulQ = { type: "noul" as const, instructions: "", criteria: { true: "t", false: "f" } };

test("normalize choice: renormalizes probabilities and keeps the argmax consistent", () => {
  const a = normalize(choiceQ, { choice: "b", confidence: 0.9, probabilities: { a: 1, b: 3, c: 1 } });
  assert.equal(a.type, "choice");
  if (a.type === "choice") {
    assert.equal(a.choice, "b");
    assert.equal(a.confidence, 0.6);
    assert.deepEqual(a.probabilities, { a: 0.2, b: 0.6, c: 0.2 });
  }
  const b = normalize(choiceQ, { choice: "a", confidence: 0.7 });          // no distribution given
  if (b.type === "choice") { assert.equal(b.choice, "a"); assert.equal(b.confidence, 0.7); assert.equal(b.probabilities.b, 0.15); }
  const c = normalize(choiceQ, { choice: "a", probabilities: { a: 0.1, b: 0.8, c: 0.1 } });  // stated choice contradicts distribution
  if (c.type === "choice") assert.equal(c.choice, "b");
});

test("normalize noul: clamps and defaults", () => {
  const a = normalize(noulQ, { noul: 1.7 }); if (a.type === "noul") assert.equal(a.noul, 1);
  const b = normalize(noulQ, { probability: 0.3 }); if (b.type === "noul") assert.equal(b.noul, 0.3);
  const c = normalize(noulQ, {}); if (c.type === "noul") assert.equal(c.noul, 0.5);
});

test("normalize score: weighted mean, legend, and level fallback", () => {
  const a = normalize(scoreQ, { probabilities: { "0": 0, "1": 1, "2": 3 } });
  if (a.type === "score") { assert.equal(a.score, 1.75); assert.equal(a.confidence, 0.75); assert.equal(a.legend["2"], "high"); }
  const b = normalize(scoreQ, { level: 2 });
  if (b.type === "score") { assert.equal(b.score, 2); assert.deepEqual(b.probabilities, { "0": 0, "1": 0, "2": 1 }); }
});
