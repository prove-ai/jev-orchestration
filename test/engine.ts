import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow } from "../src/spec/workflow.js";
import { run, resolveArgs } from "../src/runtime/engine.js";
import { ScriptedJev } from "../src/jev/mock.js";
import { createState } from "../src/spec/state.js";
import { choice, noul, score, tinyWorkflow } from "./helpers.js";
import type { RunEvent } from "../src/runtime/events.js";

const tools = {
  echo: async (args: Record<string, unknown>) => ({ got: args.text, raw: args.raw }),
  boom: async () => { throw new Error("kaboom"); },
  noop: async () => "done",
};

test("choice routes to the chosen option and the run ends with output", async () => {
  const jev = new ScriptedJev({ route: choice("a", 0.92, { b: 0.08 }) });
  const events: RunEvent[] = [];
  const s = await run({ msg: "hello", n: 7 }, { workflow: loadWorkflow(tinyWorkflow), jev, tools, onEvent: (e) => events.push(e) });
  assert.equal(s.run.status, "succeeded");
  assert.deepEqual(s.output, { got: "hello!", raw: 7 });
  assert.equal(s.decisions.length, 1);
  assert.equal(s.decisions[0].edge, "a");
  assert.deepEqual(s.decisions[0].probabilities, { a: 0.92, b: 0.08 });
  assert.equal(s.facts.pick.value, "a");
  assert.deepEqual(events.filter((e) => e.type === "edge").map((e) => e.type === "edge" && `${e.from}>${e.label}>${e.to}`), ["pick>a>do_a", "do_a>ok>ok"]);
  // Jev only saw what the node declared
  assert.deepEqual(Object.keys((jev.calls[0].state as { context: object }).context), ["input.msg"]);
});

test("low confidence takes on_unsure and stops for a human", async () => {
  const jev = new ScriptedJev({ route: choice("a", 0.4, { b: 0.35 }) });
  const s = await run({ msg: "meh" }, { workflow: loadWorkflow(tinyWorkflow), jev, tools });
  assert.equal(s.run.status, "needs_human");
  assert.equal(s.decisions[0].escalated, true);
  assert.equal(s.decisions[0].edge, "unsure");
  assert.deepEqual(s.human, { node: "ask", question: "which? meh", options: ["a", "b"] });
});

test("low confidence without on_unsure stops at the decide node", async () => {
  const wf = structuredClone(tinyWorkflow);
  const d = wf.nodes[0] as { on_unsure?: string };
  delete d.on_unsure;
  wf.nodes = wf.nodes.filter((n) => n.id !== "ask");
  const s = await run({ msg: "x" }, { workflow: loadWorkflow(wf), jev: new ScriptedJev({ route: choice("b", 0.3) }), tools });
  assert.equal(s.run.status, "needs_human");
  assert.equal(s.human?.node, "pick");
  assert.match(s.run.halt_reason ?? "", /confidence 0.3 below 0.6/);
});

test("tool error takes on_error; without on_error the run fails", async () => {
  const wf = structuredClone(tinyWorkflow);
  (wf.nodes[1] as { tool: string }).tool = "boom";
  let s = await run({ msg: "x" }, { workflow: loadWorkflow(wf), jev: new ScriptedJev({ route: choice("a") }), tools });
  assert.equal(s.run.status, "failed");           // routed to end "fail" via on_error
  assert.equal(s.actions[0].outcome, "error");
  assert.equal(s.actions[0].error, "kaboom");
  assert.equal(s.last.outcome, "error");

  delete (wf.nodes[1] as { on_error?: string }).on_error;
  s = await run({ msg: "x" }, { workflow: loadWorkflow(wf), jev: new ScriptedJev({ route: choice("a") }), tools });
  assert.equal(s.run.status, "failed");
  assert.match(s.run.halt_reason ?? "", /tool "boom" failed/);
});

test("noul check: threshold, unsure band, and stored boolean fact", async () => {
  const wf = loadWorkflow({
    name: "n", goal: { text: "t" }, start: "c",
    nodes: [
      { kind: "check", id: "c", instructions: "is it?", criteria: { true: "yes", false: "no" }, threshold: 0.6, unsure_band: 0.1, on_true: "t", on_false: "f", on_unsure: "h" },
      { kind: "end", id: "t", outcome: "succeeded" },
      { kind: "end", id: "f", outcome: "failed" },
      { kind: "human", id: "h", question: "?" },
    ],
  });
  for (const [p, status, edge] of [[0.9, "succeeded", "true"], [0.2, "failed", "false"], [0.55, "needs_human", "unsure"], [0.6, "succeeded", "true"]] as const) {
    const s = await run({}, { workflow: wf, jev: new ScriptedJev({ check: noul(p) }), tools });
    assert.equal(s.run.status, status, `p=${p}`);
    assert.equal(s.decisions[0].edge, edge);
    if (edge !== "unsure") assert.equal(s.facts.c.value, edge === "true");
  }
});

test("score assess stores an assessment and switch branches on its level", async () => {
  const wf = loadWorkflow({
    name: "s", goal: { text: "t" }, start: "a",
    nodes: [
      { kind: "assess", id: "a", instructions: "how bad", levels: ["fine", "meh", "bad"], store_as: "sev", next: "sw",
        extra: { angry: { type: "noul", instructions: "angry?", criteria: { true: "y", false: "n" } } } },
      { kind: "switch", id: "sw", on: "assessments.sev.level", cases: { "2": "bad" }, default: "ok" },
      { kind: "end", id: "bad", outcome: "failed" },
      { kind: "end", id: "ok", outcome: "succeeded" },
    ],
  });
  const jev = new ScriptedJev({ assess: score([0.1, 0.2, 0.7]), "x:angry": noul(0.8) });
  const s = await run({}, { workflow: wf, jev, tools });
  assert.equal(s.run.status, "failed");
  assert.equal(s.assessments.sev.level, 2);
  assert.equal(s.assessments.sev.label, "L2");
  assert.ok(Math.abs(s.assessments.sev.score - 1.6) < 1e-9);
  assert.equal(s.facts.angry.value, 0.8);
  assert.equal(jev.calls.length, 1, "extra question batched into the same request");
  assert.deepEqual(Object.keys(jev.calls[0].questions), ["assess", "x:angry"]);
  assert.equal(s.run.spent.jev_calls, 1);
});

test("loop guard: identical state re-entering a node halts", async () => {
  const wf = loadWorkflow({
    name: "loop", goal: { text: "t" }, start: "c",
    nodes: [
      { kind: "check", id: "c", instructions: "done?", criteria: { true: "y", false: "n" }, on_true: "end", on_false: "back" },
      { kind: "code", id: "back", fn: "nothing", next: "c" },
      { kind: "end", id: "end", outcome: "succeeded" },
    ],
  });
  const s = await run({}, { workflow: wf, jev: new ScriptedJev({ check: noul(0.1) }), tools, code: { nothing: () => {} } });
  assert.equal(s.run.status, "halted");
  assert.match(s.run.halt_reason ?? "", /re-entered with identical state/);
  assert.equal(s.run.spent.jev_calls, 2, "detected on re-entry, before a third call");
});

test("loop guard: max_visits_per_node halts a loop whose state keeps changing", async () => {
  const wf = loadWorkflow({
    name: "loop2", goal: { text: "t" }, start: "c", budget: { max_visits_per_node: 3 },
    nodes: [
      { kind: "check", id: "c", instructions: "done?", criteria: { true: "y", false: "n" }, on_true: "end", on_false: "tick" },
      { kind: "code", id: "tick", fn: "tick", next: "c" },
      { kind: "end", id: "end", outcome: "succeeded" },
    ],
  });
  let n = 0;
  const s = await run({}, { workflow: wf, jev: new ScriptedJev({ check: noul(0) }), tools, code: { tick: () => ({ facts: { n: ++n } }) } });
  assert.equal(s.run.status, "halted");
  assert.match(s.run.halt_reason ?? "", /visited 4 times/);
});

test("budget guards: max_steps and max_jev_calls", async () => {
  const wf = loadWorkflow({
    name: "b", goal: { text: "t" }, start: "c", budget: { max_jev_calls: 2, max_visits_per_node: 100 },
    nodes: [
      { kind: "check", id: "c", instructions: "done?", criteria: { true: "y", false: "n" }, on_true: "end", on_false: "tick" },
      { kind: "code", id: "tick", fn: "tick", next: "c" },
      { kind: "end", id: "end", outcome: "succeeded" },
    ],
  });
  let n = 0;
  const s = await run({}, { workflow: wf, jev: new ScriptedJev({ check: noul(0) }), tools, code: { tick: () => ({ facts: { n: ++n } }) } });
  assert.equal(s.run.status, "halted");
  assert.match(s.run.halt_reason ?? "", /max_jev_calls 2/);
  assert.equal(s.run.spent.jev_calls, 2);

  const s2 = await run({}, { workflow: wf, jev: new ScriptedJev({ check: noul(0) }), tools, code: { tick: () => ({ facts: { n: ++n } }) }, budget: { max_steps: 3, max_jev_calls: 100 } });
  assert.equal(s2.run.status, "halted");
  assert.match(s2.run.halt_reason ?? "", /max_steps 3/);
});

test("resolveArgs: $path raw values, ${path} interpolation, nested structures", () => {
  const st = createState({ id: "r", workflow: "w", workflow_version: "1", start: "x", goal: { text: "", success_criteria: [] }, input: { id: 42, name: "Ada" } });
  st.facts.inv = { value: { amount: 9.5, tags: ["a"] }, source: "tool", step: 0, at: "" };
  const out = resolveArgs({ id: "$input.id", label: "user ${input.name} owes ${facts.inv.amount}", nested: { amt: "$facts.inv.amount", list: ["$facts.inv.tags", "x"] }, missing: "$facts.nope" }, st);
  assert.deepEqual(out, { id: 42, label: "user Ada owes 9.5", nested: { amt: 9.5, list: [["a"], "x"] }, missing: undefined });
});

test("every step emits a state snapshot the live view can render", async () => {
  const events: RunEvent[] = [];
  await run({ msg: "hi" }, { workflow: loadWorkflow(tinyWorkflow), jev: new ScriptedJev({ route: choice("a") }), tools, onEvent: (e) => events.push(e) });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["run.start", "state", "node.enter", "jev.ask", "jev.answer", "edge", "state", "node.enter", "tool.call", "tool.result", "edge", "state", "node.enter", "state", "run.end"]);
});
