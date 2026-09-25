# Design: a decision tree walked by a decision-only model

## The bet

Most agent frameworks let a generative model decide *and* act *and* explain, in one loop, with the whole
transcript as context. That is flexible and expensive. This project splits the loop:

- **Decide** — Jev answers a typed question (Choice / Score / Noul) over a small, declared slice of state. 70–500 ms, input-only pricing, no reasoning tokens.
- **Act** — tools and pure code do the work and write facts.
- **Guard** — budgets and loop detection live in code and cannot be talked out of.

The graph is explicit, so it can be drawn before the run and animated during it.

## Which Jev mode where

| node | mode | why |
|---|---|---|
| `decide` | **Choice** | Outgoing edges are a closed set. Jev returns the full distribution, so `min_confidence` is a real threshold, not a vibe. Below it → `on_unsure` (a human, or a bigger model later). |
| `check` | **Noul** | Stop conditions and gates are yes/no statements: "is the goal met?", "does this need confirmation?", "is the customer asking for money back?". `threshold` + `unsure_band` map the probability to three edges. |
| `assess` | **Score** | Ordered rubrics (urgency, risk, quality). Score returns the level distribution and a weighted mean; the result is *stored*, and a deterministic `switch` branches on it. The model grades, code decides. |
| `switch` | none | When the branch is already a fact, do not spend a model call. |
| `extra` | Noul / Score | Ride-along questions batched into the same request (one HTTP call, one state view). E.g. the category decide also asks "is the customer angry?". |

## Rules that keep it cheap and honest

1. **Declared reads.** A node lists the state paths Jev may see. The live view shows exactly that payload. Undeclared input never leaks into a prompt.
2. **Criteria carry the prompt.** Option descriptions and rubric levels are the prompt. Write them as the classifier's training labels, not as instructions.
3. **Every model answer is stored verbatim** (probabilities, confidence, latency, tokens). Nothing is summarized away.
4. **Escalation is an edge.** `on_unsure` is where a stronger model or a person plugs in. The cheap path stays cheap; the hard path is explicit.
5. **Stopping is a guard.** A `check` node can say "done", but `max_steps`, `max_jev_calls`, `max_visits_per_node` and the identical-state fingerprint end the run regardless.
6. **Args are mapped, not generated.** `act` args come from state via `$path` / `${path}`. If a value must be written in prose, a `code` node or a generative model does it, and that shows in the graph.

## Composition and agents

- **`sub`** runs a registered workflow as a child run (id `parent.node`). The child's output becomes a fact;
  its Jev and agent spend fold into the parent; `max_jev_calls` is capped by what the parent has left and
  `max_depth` bounds recursion. A child that stops for a human stops the parent with the same question.
- **`parallel`** runs act and sub branches with `Promise.allSettled`. Results are keyed by branch id; a
  failed branch keeps the others' results and takes `on_error`.
- **Agents are tools.** `agentTool` wraps an `Agent` (Claude via the official SDK, or a mock) into an act
  node's tool. The prompt is a template over mapped args, so what the agent saw is in the action record.
  Agents never choose the next node; Jev does, by reading the agent's output as a fact.

## What this is not (yet)

- No planner. Trees are hand-written. A generative model that compiles a task into this spec is the natural next layer.
- No shared memory across runs; facts live for one run.
- No persistence beyond the JSONL event log in `.jev/runs/`.
- Benchmarks against a ReAct baseline on the same tasks are still to be run; `decisions[]` and `spent` record what is needed to compare.
