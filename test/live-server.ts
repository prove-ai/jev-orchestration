import { test } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer } from "../src/live/server.js";
import { loadWorkflow } from "../src/spec/workflow.js";
import { run } from "../src/runtime/engine.js";
import { ScriptedJev } from "../src/jev/mock.js";

test("live viewer serves the page, streams events, and restores encoded run IDs", async () => {
  const live = await startLiveServer({ port: 0 });
  const controller = new AbortController();
  try {
    const page = await fetch(live.url).then(r => r.text());
    assert.match(page, /Node inspector/);
    const response = await fetch(live.url + "/events", { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read(); // SSE connection comment
    const workflow = loadWorkflow({ name: "test", goal: { text: "test" }, start: "done", nodes: [{ kind: "end", id: "done", outcome: "succeeded" }] });
    await run({}, { workflow, tools: {}, jev: new ScriptedJev({}), runId: "root.child#2", onEvent: live.sink(workflow) });
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /run.start/);
    controller.abort();
    const record = await fetch(live.url + "/api/runs/" + encodeURIComponent("root.child#2")).then(r => r.json());
    assert.equal(record.state.run.status, "succeeded");
    assert.equal(record.id, "root.child#2");
    const list = await fetch(live.url + "/api/runs").then(r => r.json());
    assert.equal(list[0].id, record.id);
    assert.equal((await fetch(live.url + "/api/runs/%ZZ")).status, 400);
  } finally {
    controller.abort();
    await live.close();
  }
});
