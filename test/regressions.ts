import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/runtime/engine.js";
import { loadWorkflow } from "../src/spec/workflow.js";
import { createState } from "../src/spec/state.js";
import { buildView } from "../src/jev/view.js";
import type { Jev } from "../src/jev/types.js";

const end = { kind: "end" as const, id: "end", outcome: "succeeded" as const };
const check = { kind: "check" as const, id: "check", instructions: "test", criteria: { true: "yes", false: "no" }, on_true: "end", on_false: "end" };
const child = loadWorkflow({ name: "child", goal: { text: "test" }, start: "check", nodes: [check, end] });
function model() {
  let calls = 0;
  const jev: Jev = { ask: async () => {
    calls++;
    await Promise.resolve();
    return { model: "mock", answers: { check: { type: "noul", noul: 1 } }, usage: { input_tokens: 10, output_tokens: 0 } };
  } };
  return { jev, calls: () => calls };
}
function parallel(workflow = "child") {
  return loadWorkflow({ name: "parent", goal: { text: "test" }, start: "p", nodes: [
    { kind: "parallel", id: "p", branches: [
      { kind: "sub", id: "a", workflow }, { kind: "sub", id: "b", workflow },
    ], store_as: "results", next: "end", on_error: "end" }, end,
  ] });
}

test("parallel descendants reserve the shared call budget before making requests", async () => {
  for (const nested of [false, true]) {
    const m = model();
    const inner = parallel();
    const workflow = nested ? parallel("inner") : inner;
    const s = await run({}, { workflow, workflows: { child, inner }, jev: m.jev, tools: {}, budget: { max_jev_calls: 1 } });
    assert.equal(m.calls(), 1);
    assert.equal(s.run.spent.jev_calls, 1);
    assert.equal(s.run.status, "halted");
    assert.match(s.run.halt_reason!, /max_jev_calls/);
  }
});

test("a sequential child cannot spend an exhausted ancestor budget", async () => {
  const workflow = loadWorkflow({ name: "parent", goal: { text: "test" }, start: "check", nodes: [
    { ...check, on_true: "sub" },
    { kind: "sub", id: "sub", workflow: "child", store_as: "result", next: "end", on_error: "end" }, end,
  ] });
  const m = model();
  const s = await run({}, { workflow, workflows: { child }, jev: m.jev, tools: {}, budget: { max_jev_calls: 1 } });
  assert.equal(m.calls(), 1);
  assert.equal(s.run.status, "halted");
});

test("parallel human requests survive on_error and preserve successful sibling results", async () => {
  const humanChild = loadWorkflow({ name: "humanChild", goal: { text: "test" }, start: "check", nodes: [
    { ...check, on_true: "human" }, { kind: "human", id: "human", question: "Approve?", options: ["yes", "no"] }, end,
  ] });
  const workflow = loadWorkflow({ name: "parent", goal: { text: "test" }, start: "p", nodes: [
    { kind: "parallel", id: "p", branches: [{ kind: "sub", id: "a", workflow: "humanChild" }, { kind: "act", id: "b", tool: "noop" }], store_as: "results", next: "end", on_error: "end" }, end,
  ] });
  const s = await run({}, { workflow, workflows: { humanChild }, jev: model().jev, tools: { noop: () => 42 } });
  assert.equal(s.run.status, "needs_human");
  assert.deepEqual(s.human, { node: "human", question: "Approve?", options: ["yes", "no"] });
  assert.deepEqual(s.facts.results.value, { b: 42 });
});

test("switch uses default for inherited property names", async () => {
  const workflow = loadWorkflow({ name: "switch", goal: { text: "test" }, start: "s", nodes: [
    { kind: "switch", id: "s", on: "input.key", cases: {}, default: "end" }, end,
  ] });
  for (const key of ["toString", "constructor", "__proto__"]) {
    const s = await run({ key }, { workflow, jev: model().jev, tools: {} });
    assert.equal(s.run.status, "succeeded");
  }
});

test("token guard halts instead of reporting a runtime failure", async () => {
  const s = await run({}, { workflow: child, jev: model().jev, tools: {}, budget: { max_jev_input_tokens: 1 } });
  assert.equal(s.run.status, "halted");
  assert.equal(s.run.spent.jev_input_tokens, 10);
});

test("view respects exact serialized limits including escaping and many keys", () => {
  const state = createState({ id: "r", workflow: "w", workflow_version: "1", start: "x", goal: { text: "goal", success_criteria: [] }, input: { text: '\"\\\n'.repeat(10000) } });
  state.history.push({ step: 0, node: "x", line: "x".repeat(10000) });
  assert.ok(JSON.stringify(buildView(state, { maxChars: 1000 })).length <= 1000);
  state.input = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), "x".repeat(1000)]));
  assert.ok(JSON.stringify(buildView(state, { maxChars: 6000 })).length <= 6000);
  assert.throws(() => buildView(state, { maxChars: 200 }), /context keys exceed/);
  state.goal.text = "x".repeat(10000);
  assert.throws(() => buildView(state, { maxChars: 1000 }), /goal and last outcome exceed/);
  state.goal.text = "goal";
  state.last.error = "x".repeat(10000);
  assert.throws(() => buildView(state, { maxChars: 1000 }), /goal and last outcome exceed/);
});
