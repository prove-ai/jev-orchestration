/**
 * Example: inbound support message → triage → act → verify.
 *
 * Mode choice per node:
 *   assess  urgency      Score   ordered rubric, stored for a code switch (no branching by the model)
 *   decide  category     Choice  closed set of routes, low confidence escalates to a human
 *   check   wants_refund Noul    one yes/no statement gates a side-effecting action
 *   check   goal_met     Noul    stop condition, bounded by max_visits_per_node
 */
import { loadWorkflow, type WorkflowInput } from "../src/spec/workflow.js";
import type { CodeFn, Tool } from "../src/runtime/engine.js";
import type { Example } from "./example.js";

export const workflow: WorkflowInput = {
  name: "support-triage",
  version: "1",
  goal: {
    text: "Resolve an inbound customer support message with the right action and a reply.",
    success_criteria: ["a reply was sent", "any refund or ticket was recorded", "urgent cases are escalated"],
  },
  start: "urgency",
  budget: { max_steps: 30, max_jev_calls: 12, max_visits_per_node: 3 },
  nodes: [
    {
      kind: "assess", id: "urgency", title: "How urgent?",
      instructions: "Place the customer's message on the urgency scale.",
      reads: ["input.message"],
      levels: [
        "Informational: question or feedback, nothing blocked",
        "Minor: something is inconvenient but the customer can continue",
        "Blocking: the customer cannot use a paid feature or complete a task",
        "Critical: outage, data loss, security concern, or legal threat",
      ],
      store_as: "urgency",
      next: "urgency_gate",
    },
    {
      kind: "switch", id: "urgency_gate", title: "Critical?",
      on: "assessments.urgency.level",
      cases: { "3": "page_oncall" },
      default: "category",
    },
    {
      kind: "act", id: "page_oncall", title: "Page on-call",
      tool: "page_oncall", args: { message: "$input.message", customer_id: "$input.customer_id" },
      store_as: "page", summary: "paged ${facts.page.oncall}", next: "reply",
    },
    {
      kind: "decide", id: "category", title: "What kind of request?",
      instructions: "Pick the team that should handle this message.",
      reads: ["input.message", "assessments.urgency"],
      options: {
        billing:   { description: "Charges, invoices, refunds, subscription price, payment methods", next: "wants_refund" },
        technical: { description: "Bugs, errors, crashes, integrations, API or product not working", next: "lookup_account" },
        account:   { description: "Login, password, email change, seat management, deleting the account", next: "lookup_account" },
        other:     { description: "Sales questions, partnerships, feedback, anything not covered above", next: "create_ticket" },
      },
      min_confidence: 0.55,
      on_unsure: "ask_human",
      extra: {
        angry: { type: "noul", instructions: "Is the customer angry or threatening to leave?", criteria: { true: "Message expresses anger, frustration, or intent to cancel", false: "Message is neutral or polite" } },
      },
    },
    {
      kind: "check", id: "wants_refund", title: "Asking for a refund?",
      instructions: "Is the customer explicitly asking for money back?",
      reads: ["input.message"],
      criteria: { true: "The customer explicitly asks for a refund, chargeback, or money back", false: "The customer asks about billing but does not request money back" },
      threshold: 0.6, unsure_band: 0.1,
      on_true: "lookup_invoice", on_false: "create_ticket", on_unsure: "ask_human",
    },
    {
      kind: "act", id: "lookup_invoice", title: "Look up last invoice",
      tool: "lookup_invoice", args: { customer_id: "$input.customer_id" }, store_as: "invoice",
      summary: "invoice ${facts.invoice.id} ${facts.invoice.amount}", next: "refund_policy", on_error: "create_ticket",
    },
    {
      kind: "switch", id: "refund_policy", title: "Within policy?",
      on: "facts.invoice.refundable", cases: { true: "issue_refund" }, default: "create_ticket",
    },
    {
      kind: "act", id: "issue_refund", title: "Issue refund",
      tool: "issue_refund", args: { invoice_id: "$facts.invoice.id", amount: "$facts.invoice.amount" }, store_as: "refund",
      summary: "refunded ${facts.invoice.amount}", next: "reply", on_error: "create_ticket",
    },
    {
      kind: "act", id: "lookup_account", title: "Look up account",
      tool: "lookup_account", args: { customer_id: "$input.customer_id" }, store_as: "account",
      summary: "plan ${facts.account.plan}", next: "create_ticket", on_error: "create_ticket",
    },
    {
      kind: "act", id: "create_ticket", title: "Create ticket",
      tool: "create_ticket",
      args: { customer_id: "$input.customer_id", category: "$facts.category", urgency: "$assessments.urgency.label", message: "$input.message" },
      store_as: "ticket", summary: "ticket ${facts.ticket.id}", next: "reply",
    },
    { kind: "code", id: "reply", title: "Compose", fn: "draft_reply", next: "send_reply" },
    {
      kind: "act", id: "send_reply", title: "Send reply",
      tool: "send_reply", args: { customer_id: "$input.customer_id", text: "$facts.reply" }, store_as: "sent",
      summary: "sent reply", next: "goal_met",
    },
    {
      kind: "check", id: "goal_met", title: "Done?",
      instructions: "Given the goal and what has happened, is the customer's request now handled?",
      reads: ["input.message", "facts.reply", "facts.ticket", "facts.refund", "facts.page", "history"],
      criteria: { true: "A reply was sent and any needed refund, ticket, or page was recorded", false: "Something the customer asked for has not been addressed" },
      threshold: 0.5,
      on_true: "done", on_false: "create_ticket",
    },
    { kind: "human", id: "ask_human", title: "Ask a person", question: "Unsure how to route: ${input.message}", options: ["billing", "technical", "account", "other"] },
    { kind: "end", id: "done", title: "Resolved", outcome: "succeeded", output: "facts.reply" },
  ],
};

// ---- mock tools (replace with real integrations) ----
let seq = 100;
export const tools: Record<string, Tool> = {
  page_oncall: async ({ customer_id }) => ({ oncall: "sre-primary", incident: `INC-${++seq}`, customer_id }),
  lookup_invoice: async ({ customer_id }) => {
    if (customer_id === "c-missing") throw new Error("no invoice on file");
    return { id: `inv_${customer_id}`, amount: "$49.00", refundable: customer_id !== "c-old" };
  },
  issue_refund: async ({ invoice_id, amount }) => ({ refund_id: `rf_${++seq}`, invoice_id, amount }),
  lookup_account: async ({ customer_id }) => ({ id: customer_id, plan: "pro", seats: 5 }),
  create_ticket: async ({ category, urgency }) => ({ id: `T-${++seq}`, category, urgency }),
  send_reply: async ({ text }) => ({ delivered: true, chars: String(text).length }),
};

export const code: Record<string, CodeFn> = {
  draft_reply: (state) => {
    const f = (k: string) => state.facts[k]?.value as Record<string, unknown> | undefined;
    const parts: string[] = ["Thanks for reaching out."];
    if (f("page")) parts.push(`We've escalated this to our on-call engineer (${f("page")!.incident}).`);
    if (f("refund")) parts.push(`A refund of ${f("refund")!.amount} has been issued to your original payment method.`);
    if (f("ticket")) parts.push(`We've opened ticket ${f("ticket")!.id} and will follow up shortly.`);
    return { facts: { reply: parts.join(" ") } };
  },
};

const main = loadWorkflow(workflow);
export const example: Example = {
  main,
  workflows: { [main.name]: main },
  tools,
  code,
  inputs: [
    { message: "I was charged twice this month, please refund the duplicate charge.", customer_id: "c-123" },
    { message: "The API returns 500 errors since this morning and our integration is down.", customer_id: "c-777" },
    { message: "Production is completely down for all our users, data appears to be missing!", customer_id: "c-900" },
    { message: "hi", customer_id: "c-1" },
  ],
  inputFromArgs: (a) => (a.message ? { message: String(a.message), customer_id: String(a.customer ?? "c-123") } : null),
};
