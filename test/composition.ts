import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow, WorkflowError, checkRegistry } from "../src/spec/workflow.js";
import { run } from "../src/runtime/engine.js";
import { ScriptedJev } from "../src/jev/mock.js";
import { agentTool, MockAgent, renderTemplate } from "../src/agents/agent.js";
import { choice, noul, score } from "./helpers.js";
import type { RunEvent } from "../src/runtime/events.js";

/** child: decide → end (output facts.pick) */
const child = loadWorkflow({
  name: "child", goal: { text: "c" }, start: "pick",
  nodes: [
    { kind: "decide", id: "pick", instructions: "pick", reads: ["input.x"], options: { a: { description: "A", next: "ok" }, b: { description: "B", next: "bad" } }, min_confidence: 0.6, on_unsure: "ask" },
    { kind: "human", id: "ask", question: "which?" },
    { kind: "end", id: "ok", outcome: "succeeded", output: "facts.pick" },
    { kind: "end", id: "bad", outcome: "failed" },
  ],
});

const parent = loadWorkflow({
  name: "parent", goal: { text: "p" }, start: "call",
  nodes: [
    { kind: "sub", id: "call", workflow: "child", input: { x: "${input.msg}!" }, store_as: "child_out", next: "done", on_error: "fallback" },
    { kind: "end", id: "done", outcome: "succeeded", output: "facts.child_out" },
    { kind: "end", id: "fallback", outcome: "failed" },
  ],
});
const workflows = { parent, child };
const tools = {
  upper: async (a: Record<string, unknown>) => String(a.text).toUpperCase(),
  slow: async (a: Record<string, unknown>) => { await new Promise((r) => setTimeout(r, Number(a.ms))); return `slept ${a.ms}`; },
  boom: async () => { throw new Error("kaboom"); },
};

test("sub: child output becomes a fact, child input is mapped, spend folds into parent", async () => {
  const jev = new ScriptedJev({ route: choice("a", 0.9) });
  const events: RunEvent[] = [];
  const s = await run({ msg: "hi" }, { workflow: parent, workflows, jev, tools, onEvent: (e) => events.push(e) });
  assert.equal(s.run.status, "succeeded");
  assert.equal(s.output, "a");
  assert.equal(s.facts.child_out.value, "a");
  assert.equal(s.run.spent.jev_calls, 1, "child's jev call counted in parent");
  assert.deepEqual((jev.calls[0].state as { context: Record<string, unknown> }).context, { "input.x": "hi!" });
  const starts = events.filter((e) => e.type === "run.start");
  assert.deepEqual(starts.map((e) => e.type === "run.start" && [e.run_id, e.parent, e.depth]), [[s.run.id, null, 0], [`${s.run.id}.call`, s.run.id, 1]]);
  assert.equal(s.actions[0].tool, "workflow:child");
});

test("sub: child failure takes on_error; child needs_human propagates to the parent", async () => {
  let s = await run({ msg: "x" }, { workflow: parent, workflows, jev: new ScriptedJev({ route: choice("b", 0.9) }), tools });
  assert.equal(s.run.status, "failed");                     // via on_error → fallback end
  assert.equal(s.actions[0].outcome, "error");
  assert.equal(s.last.error, "failed: null");

  s = await run({ msg: "x" }, { workflow: parent, workflows, jev: new ScriptedJev({ route: choice("a", 0.2) }), tools });
  assert.equal(s.run.status, "needs_human");
  assert.equal(s.human?.question, "which?");
  assert.match(s.run.halt_reason ?? "", /sub "call"/);
});

test("sub: unknown workflow is rejected up front; recursion is capped by max_depth", async () => {
  assert.throws(() => checkRegistry({ parent }), (e: unknown) => e instanceof WorkflowError && /unknown workflow "child"/.test(e.message));
  const recursive = loadWorkflow({
    name: "rec", goal: { text: "r" }, start: "again", budget: { max_depth: 2 },
    nodes: [{ kind: "sub", id: "again", workflow: "rec", store_as: "x", next: "done" }, { kind: "end", id: "done", outcome: "succeeded" }],
  });
  const s = await run({}, { workflow: recursive, workflows: { rec: recursive }, jev: new ScriptedJev({}), tools });
  assert.equal(s.run.status, "failed");
  assert.match(s.run.halt_reason ?? "", /halted: budget: max_depth 2/);
});

test("parallel: branches run concurrently, results keyed by branch id, sub branches allowed", async () => {
  const wf = loadWorkflow({
    name: "par", goal: { text: "p" }, start: "fan",
    nodes: [
      { kind: "parallel", id: "fan", store_as: "r", next: "done", branches: [
        { id: "one", kind: "act", tool: "slow", args: { ms: 60 } },
        { id: "two", kind: "act", tool: "slow", args: { ms: 60 } },
        { id: "three", kind: "act", tool: "upper", args: { text: "$input.msg" } },
        { id: "kid", kind: "sub", workflow: "child", input: { x: "$input.msg" } },
      ] },
      { kind: "end", id: "done", outcome: "succeeded", output: "facts.r" },
    ],
  });
  const t0 = Date.now();
  const s = await run({ msg: "yo" }, { workflow: wf, workflows: { par: wf, child }, jev: new ScriptedJev({ route: choice("a") }), tools });
  const elapsed = Date.now() - t0;
  assert.equal(s.run.status, "succeeded");
  assert.deepEqual(s.output, { one: "slept 60", two: "slept 60", three: "YO", kid: "a" });
  assert.ok(elapsed < 110, `branches should overlap (took ${elapsed}ms)`);
  assert.equal(s.actions.length, 4);
  assert.equal(s.actions.find((a) => a.node === "fan/kid")?.tool, "workflow:child");
  assert.equal(s.run.spent.jev_calls, 1);
});

test("parallel: one failing branch keeps partial results and takes on_error; without on_error the run fails", async () => {
  const mk = (onError: boolean) => loadWorkflow({
    name: "par2", goal: { text: "p" }, start: "fan",
    nodes: [
      { kind: "parallel", id: "fan", store_as: "r", next: "done", ...(onError ? { on_error: "partial" } : {}), branches: [
        { id: "good", kind: "act", tool: "upper", args: { text: "ok" } },
        { id: "bad", kind: "act", tool: "boom" },
      ] },
      { kind: "end", id: "done", outcome: "succeeded" },
      ...(onError ? [{ kind: "end" as const, id: "partial", outcome: "succeeded" as const, output: "facts.r" }] : []),
    ],
  });
  let s = await run({}, { workflow: mk(true), jev: new ScriptedJev({}), tools });
  assert.equal(s.run.status, "succeeded");
  assert.deepEqual(s.output, { good: "OK" });
  assert.match(s.last.error ?? "", /bad: kaboom/);
  s = await run({}, { workflow: mk(false), jev: new ScriptedJev({}), tools });
  assert.equal(s.run.status, "failed");
  assert.match(s.run.halt_reason ?? "", /parallel "fan": bad: kaboom/);
});

test("agentTool: renders the prompt from args, returns text, meters usage into the run", async () => {
  const agent = new MockAgent("writer", (p) => `wrote: ${p}`);
  const wf = loadWorkflow({
    name: "ag", goal: { text: "a" }, start: "w",
    nodes: [
      { kind: "act", id: "w", tool: "writer", args: { topic: "$input.topic", notes: "$facts.none" }, store_as: "draft", next: "done" },
      { kind: "end", id: "done", outcome: "succeeded", output: "facts.draft" },
    ],
  });
  const events: RunEvent[] = [];
  const s = await run({ topic: "cats" }, {
    workflow: wf, jev: new ScriptedJev({}),
    tools: { writer: agentTool(agent, { system: "sys", prompt: "Topic: ${topic}. Notes: ${notes}." }) },
    onEvent: (e) => events.push(e),
  });
  assert.equal(s.output, "wrote: Topic: cats. Notes: .");
  assert.equal(agent.calls[0].system, "sys");
  assert.equal(s.run.spent.agent_calls, 1);
  assert.ok(s.run.spent.agent_input_tokens > 0 && s.run.spent.agent_output_tokens > 0);
  const m = events.find((e) => e.type === "agent");
  assert.ok(m && m.type === "agent" && m.agent === "writer" && m.model === "mock");
});

test("renderTemplate: strings verbatim, objects as JSON, missing as empty", () => {
  assert.equal(renderTemplate("a=${a} b=${b.c} m=${m}", { a: "x", b: { c: [1, 2] } }), 'a=x b=[\n 1,\n 2\n] m=');
});

test("research example: parallel researchers → draft loop → grade → done, with scripted jev", async () => {
  const { makeExample } = await import("../examples/research-review.js");
  const ex = makeExample("mock");
  let checks = 0;
  const jev = new ScriptedJev((_s, q) => q.type === "noul" ? noul(++checks === 1 ? 0.1 : 0.95) : q.type === "score" ? score([0, 0.1, 0.7, 0.2]) : choice("x"));
  const s = await run({ topic: "t" }, { workflow: ex.main, workflows: ex.workflows, jev, tools: ex.tools });
  assert.equal(s.run.status, "succeeded");
  assert.match(String(s.output), /Recommendation/);
  assert.equal(s.run.spent.agent_calls, 5, "2 researchers + writer, reviewer, writer");
  assert.equal(s.run.spent.jev_calls, 3, "2 completeness checks + 1 grade");
  assert.equal(s.assessments.quality.level, 2);
  assert.deepEqual(Object.keys(s.facts.research.value as object), ["for", "against"]);
});
