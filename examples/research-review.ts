/**
 * Multi-agent example: two researchers in parallel → a bounded draft/critique loop
 * (sub-workflow) → Jev grades the draft → revise once if weak.
 *
 * Agents are Claude when credentials are present (ANTHROPIC_API_KEY or `ant auth login`),
 * otherwise deterministic mocks. Jev decides between nodes; agents only work inside act nodes.
 */
import { loadWorkflow, type WorkflowInput } from "../src/spec/workflow.js";
import type { Tool } from "../src/runtime/engine.js";
import { agentTool, MockAgent, type Agent } from "../src/agents/agent.js";
import { ClaudeAgent } from "../src/agents/claude.js";
import type { Example } from "./example.js";

const draftLoop: WorkflowInput = {
  name: "draft-loop",
  goal: { text: "Produce a brief that covers both the case for and the risks of the topic.", success_criteria: ["case for", "risks", "recommendation"] },
  start: "draft",
  budget: { max_visits_per_node: 3 },
  nodes: [
    {
      kind: "act", id: "draft", title: "Writer drafts", tool: "writer",
      args: { topic: "$input.topic", research: "$input.research", feedback: "$facts.feedback" },
      store_as: "draft", summary: "draft ${facts.draft}", next: "complete",
    },
    {
      kind: "check", id: "complete", title: "Complete?",
      instructions: "Does the draft cover both the case for and the risks, and end with a recommendation?",
      reads: ["input.topic", "facts.draft"],
      criteria: { true: "The draft presents the case for, the risks, and a clear recommendation", false: "The draft is missing the case for, the risks, or a recommendation" },
      threshold: 0.5, on_true: "done", on_false: "critique",
    },
    {
      kind: "act", id: "critique", title: "Reviewer critiques", tool: "reviewer",
      args: { topic: "$input.topic", draft: "$facts.draft" },
      store_as: "feedback", summary: "feedback ${facts.feedback}", next: "draft",
    },
    { kind: "end", id: "done", outcome: "succeeded", output: "facts.draft" },
  ],
};

const researchReview: WorkflowInput = {
  name: "research-review",
  goal: { text: "Deliver a balanced, well-sourced brief on the topic.", success_criteria: ["two independent research angles", "draft passed completeness check", "quality at least adequate"] },
  start: "gather",
  budget: { max_jev_calls: 12, max_visits_per_node: 2 },
  nodes: [
    {
      kind: "parallel", id: "gather", title: "Two researchers",
      branches: [
        { id: "for", kind: "act", tool: "researcher_for", args: { topic: "$input.topic" } },
        { id: "against", kind: "act", tool: "researcher_against", args: { topic: "$input.topic" } },
      ],
      store_as: "research", next: "write",
    },
    {
      kind: "sub", id: "write", title: "Draft loop", workflow: "draft-loop",
      input: { topic: "$input.topic", research: "$facts.research" },
      store_as: "draft", summary: "draft ready", next: "quality",
    },
    {
      kind: "assess", id: "quality", title: "Grade the draft",
      instructions: "Rate the brief's quality for a decision maker.",
      reads: ["input.topic", "facts.draft"],
      levels: [
        "Unusable: vague, one-sided, or off topic",
        "Weak: covers the topic but thin on evidence or missing risks",
        "Adequate: balanced, specific, actionable recommendation",
        "Strong: balanced, specific, cites concrete facts, crisp recommendation",
      ],
      store_as: "quality", next: "gate",
    },
    { kind: "switch", id: "gate", title: "Good enough?", on: "assessments.quality.level", cases: { "0": "write", "1": "write" }, default: "done" },
    { kind: "end", id: "done", title: "Brief ready", outcome: "succeeded", output: "facts.draft" },
  ],
};

export function makeAgents(kind: "claude" | "mock"): Record<string, Agent> {
  if (kind === "claude") {
    return {
      researcher_for: new ClaudeAgent("researcher_for"),
      researcher_against: new ClaudeAgent("researcher_against"),
      writer: new ClaudeAgent("writer"),
      reviewer: new ClaudeAgent("reviewer"),
    };
  }
  return {
    researcher_for: new MockAgent("researcher_for", (p) => `Case for: adoption of the topic ${p.match(/topic: (.*)/)?.[1] ?? ""} lowers cost and speeds delivery; two pilots reported 30% faster cycles.`),
    researcher_against: new MockAgent("researcher_against", () => `Risks: vendor lock-in, uneven accuracy on edge cases, and hidden migration cost; one pilot was rolled back.`),
    // first draft is one-sided so the loop runs once; second draft is complete
    writer: new MockAgent("writer", (_p, n) => n === 1
      ? "Brief: the case for is strong: lower cost and faster delivery, pilots show 30% faster cycles."
      : "Brief: the case for is lower cost and faster delivery (pilots: 30% faster cycles). The risks are vendor lock-in, uneven accuracy, and migration cost; one rollback. Recommendation: run a scoped pilot with an exit plan."),
    reviewer: new MockAgent("reviewer", () => "Missing: the risks section and a clear recommendation."),
  };
}

export function makeTools(agents: Record<string, Agent>): Record<string, Tool> {
  const sys = "You are a concise analyst. Answer in at most 120 words. No preamble.";
  return {
    researcher_for: agentTool(agents.researcher_for, { system: sys, prompt: "Make the strongest evidence-based case FOR this topic: ${topic}. Bullet points with concrete facts." }),
    researcher_against: agentTool(agents.researcher_against, { system: sys, prompt: "List the strongest risks and counter-arguments AGAINST this topic: ${topic}. Bullet points with concrete facts." }),
    writer: agentTool(agents.writer, { system: sys, prompt: "Write a brief (under 150 words) on: ${topic}.\n\nResearch:\n${research}\n\nIt must cover the case for, the risks, and end with a recommendation.${feedback}" }),
    reviewer: agentTool(agents.reviewer, { system: sys, prompt: "Topic: ${topic}\n\nDraft:\n${draft}\n\nIn two sentences, say what is missing for a balanced brief (case for, risks, recommendation)." }),
  };
}

const main = loadWorkflow(researchReview);
const loop = loadWorkflow(draftLoop);

export function makeExample(kind: "claude" | "mock"): Example {
  return {
    main,
    workflows: { [main.name]: main, [loop.name]: loop },
    tools: makeTools(makeAgents(kind)),
    inputs: [{ topic: "replacing our LangGraph router with a decision-only model" }],
    inputFromArgs: (a) => (a.topic ? { topic: String(a.topic) } : null),
  };
}
