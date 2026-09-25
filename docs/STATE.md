# RunState — the one document a run carries

Source of truth: [`src/spec/state.ts`](../src/spec/state.ts) (zod). This page explains the intent behind each field.

```
RunState
├─ run            bookkeeping: id, workflow, status, cursor, step, budget, spent, halt_reason
├─ goal           what the run is for (text + success_criteria) — always sent to Jev
├─ input          the original task input — immutable
├─ facts          working memory: { key → { value, source, step, at } }
├─ assessments    Score results:  { key → { level, label, score, confidence, probabilities, step } }
├─ decisions[]    every Jev-backed routing step, with probabilities, edge taken, escalated flag
├─ actions[]      every tool call: args, outcome, summary, error, duration
├─ last           last act/code outcome — the only thing error routing needs
├─ history[]      one human-readable line per step; the tail is sent to Jev
├─ human          set when the run stops for a person: { node, question, options }
└─ output         final result, copied from a state path by the end node
```

## run

| field | meaning |
|---|---|
| `status` | `running` · `succeeded` · `failed` · `halted` (a guard fired) · `needs_human` |
| `cursor` | id of the node about to execute — the live view highlights it |
| `budget` | `max_steps`, `max_jev_calls`, `max_jev_input_tokens`, `max_wall_ms`, `max_visits_per_node` |
| `spent` | counters against the budget; `jev_input_tokens` from the Jev `usage` field; `agent_calls` / `agent_input_tokens` / `agent_output_tokens` from agent tools; child runs fold into the parent |
| `parent`, `depth` | set on child runs started by `sub` / `parallel` nodes; `max_depth` caps nesting |
| `halt_reason` | why the run is not `running`/`succeeded`, e.g. `loop: node "goal_met" re-entered with identical state` |

Guards are enforced in code before each node, never by the model. A second loop guard fingerprints
`(node, fact values, assessment levels, output, last outcome)` and halts on an exact repeat.

## facts

`facts` is the only mutable memory. Writers: `act` nodes (`store_as`), `code` nodes (`facts` in their return),
`decide`/`check` nodes (the chosen option or boolean lands under the node's id), and `extra` Noul questions.
Each fact records its `source` (`input | tool | code | jev | human`) and the step it was written, so the
audit trail says who put what where.

Paths: `facts.invoice` unwraps to the value; `facts.invoice.amount` reaches inside it.

## assessments

Where Score answers land. `level` is the argmax rubric level, `label` its text, `score` the weighted mean
(2.68 on a 4-level rubric means "between level 2 and 3"). `switch` nodes branch on `assessments.x.level`;
`check` nodes can read `assessments.x` for a second opinion.

## decisions

One entry per `decide` / `check` / `assess` node execution. Keeps the full probability distribution, the
confidence, the edge taken, whether it escalated, the latency and the input tokens. This is what the
live view's "Decisions" panel renders, and what a later benchmark compares against a ReAct baseline.

## What Jev sees

Never the whole document. `buildView` ([`src/jev/view.ts`](../src/jev/view.ts)) sends:

```
{ goal, step, context: { <each declared read path>: value }, last, recent: [last 8 history lines] }
```

If a node declares no `reads`, it gets all of `input`, `facts` and `assessments`. Oversized views drop
history first, then truncate long strings, staying well under Jev's 32k-token state cap.
