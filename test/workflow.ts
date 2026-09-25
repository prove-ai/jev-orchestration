import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow, WorkflowError } from "../src/spec/workflow.js";
import { tinyWorkflow } from "./helpers.js";
import { workflow as triage } from "../examples/support-triage.js";

test("example workflow validates", () => {
  const wf = loadWorkflow(triage);
  assert.equal(wf.nodes.length, 15);
});

test("rejects dangling edges", () => {
  const wf = structuredClone(tinyWorkflow);
  (wf.nodes[0] as { options: Record<string, { next: string }> }).options.a.next = "nowhere";
  assert.throws(() => loadWorkflow(wf), (e: unknown) => e instanceof WorkflowError && /unknown node "nowhere"/.test(e.message));
});

test("rejects unreachable nodes and missing start", () => {
  const wf = structuredClone(tinyWorkflow);
  wf.nodes.push({ kind: "end", id: "island", outcome: "failed" });
  assert.throws(() => loadWorkflow(wf), /unreachable nodes: island/);
  wf.nodes.pop();
  wf.start = "nope";
  assert.throws(() => loadWorkflow(wf), /start node "nope"/);
});

test("rejects reserved option key and bad level counts", () => {
  const wf = structuredClone(tinyWorkflow);
  (wf.nodes[0] as { options: Record<string, unknown> }).options.unsure = { description: "x", next: "ok" };
  assert.throws(() => loadWorkflow(wf), /"unsure" is reserved/);
  assert.throws(() => loadWorkflow({ name: "s", goal: { text: "" }, start: "a", nodes: [{ kind: "assess", id: "a", instructions: "", levels: ["only"], store_as: "x", next: "e" }, { kind: "end", id: "e", outcome: "succeeded" }] }));
});
