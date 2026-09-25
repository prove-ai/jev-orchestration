# jev-orchestration

Decision-tree orchestration for agents. [Jev](https://docs.typesafe.ai/models.md) (a decision-only model with
**Choice / Score / Noul** question types) picks the branch, code and tools do the work, every step is
visible live. No reasoning tokens, no transcript in the prompt, 70–500 ms per decision.

```
assess ──▶ switch ──▶ decide ──▶ check ──▶ act ──▶ code ──▶ act ──▶ check ──▶ end
(Score)   (code)    (Choice)   (Noul)   (tool)         (tool)   (Noul)
                        └─ unsure ──▶ human
```

## Run it

```bash
npm install
npm test                 # 19 tests, scripted Jev, no network
npm run demo             # four support messages through the triage tree (real Jev if JEV_API_KEY is set)
npm run live             # same, plus http://127.0.0.1:4343 with the tree, cursor, probabilities, state
```

With a real key: put it in `.env` (see `.env.example`). When `JEV_API_KEY` is set the demo uses the
real model automatically; `--jev heuristic` forces the stand-in.

```bash
npm run demo -- --message "I was charged twice, refund me"
```

## Write a workflow

A workflow is data ([`src/spec/workflow.ts`](src/spec/workflow.ts)); see
[`examples/support-triage.ts`](examples/support-triage.ts). Node kinds:

| kind | Jev mode | branches by |
|---|---|---|
| `decide` | Choice | option key; `min_confidence` → `on_unsure` |
| `check` | Noul | `threshold`, optional `unsure_band` → `on_true` / `on_false` / `on_unsure` |
| `assess` | Score | never; stores `assessments[store_as]` |
| `act` | — | `next` / `on_error`; args mapped from state with `$path` and `${path}` |
| `code` | — | `next`; pure function that returns `facts` / `output` |
| `switch` | — | `cases[String(value)]` / `default` |
| `sub` | — | runs another registered workflow with mapped `input`; its output becomes `facts[store_as]`; `next` / `on_error`; a child that needs a human stops the parent |
| `parallel` | — | runs `act` and `sub` branches concurrently; `facts[store_as] = { branch: result }`; `next` / `on_error` (partial results kept) |
| `human` | — | stops with `needs_human` |
| `end` | — | terminal, copies `output` from a state path |

Every Jev-backed node declares `reads`: the state paths it may see. `extra` batches ride-along
Noul/Score questions into the same request.

## Multi-agent

Agents are tools. `agentTool(agent, { system, prompt })` turns any `Agent` into a Tool whose prompt is a
template over the act node's mapped args; token usage is metered into `run.spent`. `ClaudeAgent` uses the
official SDK (`ANTHROPIC_API_KEY` in `.env`, or an `ant auth login` profile; default model `claude-opus-5`,
effort `low`, override with `CLAUDE_AGENT_MODEL`). `MockAgent` is the keyless stand-in.

[`examples/research-review.ts`](examples/research-review.ts): two researcher agents in `parallel`, a
`sub` workflow that loops writer → Jev completeness check → reviewer (bounded), then Jev grades the draft
and a `switch` sends weak drafts back once.

```bash
npm run demo -- --example research --topic "moving our router to a decision-only model"
npm run demo -- --example research --agents mock      # no Claude calls
```

Jev is the supervisor: it decides which node runs next and judges agent output. Agents never decide
control flow. Child runs show up in the live view under their parent (`↳`).

## Benchmark: Jev vs a generative router

`npm run bench` runs the same workflows, tools and labeled inputs with the decision layer swapped:
Jev, or `ClaudeRouter` (Claude answering the same Choice/Noul/Score questions as JSON, the
LangGraph-style pattern). Labels are hand-written in [`bench/cases.ts`](bench/cases.ts): 24 triage
messages and 12 drafts. Results are saved under `.jev/bench/` and can be re-scored offline with
`--rescore <file>`.

Run of 2026-09-25 (Jev 1.13.0; Claude routers at effort `low`, 1 pass, concurrency 4):

| router | category | urgency (±1) | refund | outcome | complete | quality (±1) | p50 / p95 latency | USD per decision |
|---|---|---|---|---|---|---|---|---|
| jev | 76% | 71% (96%) | 100% | 79% | 100% | 100% (100%) | 135 / 291 ms | $0.00002 |
| claude-opus-5 | 76% | 67% (96%) | 100% | 79% | 100% | 67% (100%) | 1530 / 2932 ms | $0.00484 |
| claude-sonnet-5 | 76% | 67% (96%) | 100% | 79% | 100% | 83% (100%) | 1287 / 1802 ms | $0.00194 |

Agreement with Jev, ignoring labels: Opus matched Jev on 100% of categories and outcomes and 96% of
urgency levels; Sonnet 100% / 100% / 79%. Where the routers "miss", they miss together: the same
messages read as critical by all three under the rubric while the labeler rated them blocking, and two
deliberately vague messages ("hi", "it's broken again") that all three routed with confidence above the
0.55 threshold instead of escalating. Those are rubric and threshold questions, not model differences.

Caveats: one pass, small n, labels by one person, mock tools, and the Claude routers were not prompt-tuned.
The numbers to trust are the order-of-magnitude gaps in latency and cost; the accuracy parity is
suggestive, not proven.

## Layout

```
src/spec/state.ts      RunState schema and path resolution        docs/STATE.md
src/spec/workflow.ts   node/edge schema, validation                docs/DESIGN.md
src/jev/               wire types, HTTP client, scripted + heuristic stand-ins, state view builder
src/runtime/engine.ts  the walker: guards, Jev calls, tools, events
src/agents/            Agent interface, agentTool adapter, ClaudeAgent (official SDK), MockAgent
src/live/              SSE server + single-page tree view (child runs listed under their parent)
examples/              support-triage (single tree) and research-review (parallel + sub + agents)
test/                  engine, workflow validation, view
```

Event log per run: `.jev/runs/<id>.jsonl`.

## Live decision graph in your application

Start the local viewer before running a workflow, open its URL, and attach its event sink:

```ts
import { startLiveServer } from "./src/live/server.js";
import { run } from "./src/runtime/engine.js";

const live = await startLiveServer({ port: 4343 });
console.log(live.url); // Open this URL before starting the run.

const result = await run(input, {
  workflow,
  workflows,
  jev,
  tools,
  onEvent: live.sink(Object.values(workflows)),
});
// Keep the server running to inspect the trace; call await live.close() on shutdown.
```

Register the root workflow and all child workflows with the sink (or pass the root workflow directly
if it has no children). The dashboard shows active and visited nodes, chosen edges, decision
probabilities, tool calls, and child runs. Select a node to inspect it; **Follow active** resumes
tracking. Zoom and **Fit** help navigate larger graphs. Selecting a child run shows its own graph.
The viewer reconnects automatically and reloads the latest trace. It is read-only: human requests
are displayed for inspection, not approved from the dashboard.

For the bundled demo without model calls: `npm run live -- --jev heuristic --agents mock`.
Fast workflows may finish before the browser opens; their completed traces remain available.
