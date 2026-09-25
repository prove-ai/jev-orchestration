/**
 * Labeled cases. Labels are hand-written by the benchmark author (2026-09-25), not model-generated.
 *
 * Triage: expected urgency level (0..3), category, refund (only meaningful for billing), and the
 * end-to-end outcome the workflow should reach: refund | ticket | page | human.
 * Draft: whether a draft is complete (case for + risks + recommendation) and its quality level (0..3).
 */
export interface TriageCase {
  id: string;
  message: string;
  customer_id: string;
  urgency: number;
  category: "billing" | "technical" | "account" | "other" | "unsure";
  refund: boolean | null;
  outcome: "refund" | "ticket" | "page" | "human";
}

export const triageCases: TriageCase[] = [
  { id: "t01", message: "I was charged twice this month, please refund the duplicate charge.", customer_id: "c-123", urgency: 1, category: "billing", refund: true, outcome: "refund" },
  { id: "t02", message: "Can you send me last month's invoice as a PDF for my accountant?", customer_id: "c-124", urgency: 0, category: "billing", refund: false, outcome: "ticket" },
  { id: "t03", message: "I cancelled in March but you still billed me in April and May. I want that money back.", customer_id: "c-125", urgency: 1, category: "billing", refund: true, outcome: "refund" },
  { id: "t04", message: "Why did my subscription price go up from $29 to $39?", customer_id: "c-126", urgency: 0, category: "billing", refund: false, outcome: "ticket" },
  { id: "t05", message: "Please refund my last payment, I never used the product after the trial.", customer_id: "c-old", urgency: 1, category: "billing", refund: true, outcome: "ticket" },
  { id: "t06", message: "My card was declined and now the account says payment failed. Can I switch to invoicing?", customer_id: "c-127", urgency: 1, category: "billing", refund: false, outcome: "ticket" },
  { id: "t07", message: "The API returns 500 errors since this morning and our integration is down.", customer_id: "c-777", urgency: 2, category: "technical", refund: null, outcome: "ticket" },
  { id: "t08", message: "Webhooks arrive about 10 minutes late. Not urgent but annoying.", customer_id: "c-778", urgency: 1, category: "technical", refund: null, outcome: "ticket" },
  { id: "t09", message: "Export to CSV crashes the page every time I include the date column.", customer_id: "c-779", urgency: 2, category: "technical", refund: null, outcome: "ticket" },
  { id: "t10", message: "Is there a rate limit on the search endpoint? The docs don't say.", customer_id: "c-780", urgency: 0, category: "technical", refund: null, outcome: "ticket" },
  { id: "t11", message: "Production is completely down for all our users, data appears to be missing!", customer_id: "c-900", urgency: 3, category: "technical", refund: null, outcome: "page" },
  { id: "t12", message: "We think someone accessed our workspace with a stolen token. Need help now.", customer_id: "c-901", urgency: 3, category: "account", refund: null, outcome: "page" },
  { id: "t13", message: "I can't log in, the password reset email never arrives.", customer_id: "c-300", urgency: 2, category: "account", refund: null, outcome: "ticket" },
  { id: "t14", message: "Please change the owner email on our account to ops@example.com.", customer_id: "c-301", urgency: 0, category: "account", refund: null, outcome: "ticket" },
  { id: "t15", message: "How do I add three more seats for my team?", customer_id: "c-302", urgency: 0, category: "account", refund: null, outcome: "ticket" },
  { id: "t16", message: "Delete my account and all my data, I'm leaving.", customer_id: "c-303", urgency: 1, category: "account", refund: null, outcome: "ticket" },
  { id: "t17", message: "Do you offer a partnership or reseller program?", customer_id: "c-400", urgency: 0, category: "other", refund: null, outcome: "ticket" },
  { id: "t18", message: "Love the new dashboard, great work!", customer_id: "c-401", urgency: 0, category: "other", refund: null, outcome: "ticket" },
  { id: "t19", message: "We're evaluating you against two competitors. Can someone from sales call me?", customer_id: "c-402", urgency: 0, category: "other", refund: null, outcome: "ticket" },
  { id: "t20", message: "hi", customer_id: "c-1", urgency: 0, category: "unsure", refund: null, outcome: "human" },
  { id: "t21", message: "it's broken again", customer_id: "c-2", urgency: 1, category: "unsure", refund: null, outcome: "human" },
  { id: "t22", message: "Our legal team will be in touch regarding the outage that lost our customer records.", customer_id: "c-902", urgency: 3, category: "technical", refund: null, outcome: "page" },
  { id: "t23", message: "Two-factor codes stopped working for our whole team, nobody can get in.", customer_id: "c-304", urgency: 2, category: "account", refund: null, outcome: "ticket" },
  { id: "t24", message: "The invoice shows the wrong company name, can you fix it? No refund needed.", customer_id: "c-128", urgency: 0, category: "billing", refund: false, outcome: "ticket" },
];

export interface DraftCase {
  id: string;
  topic: string;
  draft: string;
  complete: boolean;
  quality: number;  // 0 unusable, 1 weak, 2 adequate, 3 strong
}

export const draftCases: DraftCase[] = [
  { id: "d01", topic: "adopting a decision-only router", complete: true, quality: 3,
    draft: "Case for: routing is classification; learned routers keep ~95% of quality at up to 85% lower cost and answer in tens of milliseconds. Risks: 95% per-hop accuracy compounds to ~74% over six hops, and you lose compile-time graph checks and clear audit trails. Recommendation: keep a deterministic skeleton, insert the router only at high-entropy nodes behind golden-set tests." },
  { id: "d02", topic: "adopting a decision-only router", complete: false, quality: 1,
    draft: "Case for: routing is classification and cheap routers are fast and inexpensive. Two pilots showed 30% faster cycles. Costs drop substantially." },
  { id: "d03", topic: "adopting a decision-only router", complete: false, quality: 1,
    draft: "Risks: vendor lock-in, uneven accuracy on edge cases, silent drift on model upgrades. One pilot was rolled back. Recommendation: do not adopt this quarter." },
  { id: "d04", topic: "adopting a decision-only router", complete: true, quality: 2,
    draft: "The case for is lower cost and faster decisions. The risks are lock-in and accuracy drift. Recommendation: run a scoped pilot with an exit plan." },
  { id: "d05", topic: "adopting a decision-only router", complete: false, quality: 0,
    draft: "Routers are interesting. There are many options in the market and teams should think carefully about what they need. It depends." },
  { id: "d06", topic: "migrating the data warehouse to a lakehouse", complete: true, quality: 3,
    draft: "Case for: open table formats cut storage cost roughly 60% versus the current warehouse and remove the nightly copy job; two teams already query Parquet directly. Risks: query latency on small interactive workloads is 2-3x worse, and the migration touches 140 dashboards. Recommendation: move batch and ML workloads first, keep the warehouse for BI for two quarters, then re-evaluate." },
  { id: "d07", topic: "migrating the data warehouse to a lakehouse", complete: false, quality: 1,
    draft: "A lakehouse would cut storage cost and simplify pipelines. Open formats avoid lock-in. Several peers have migrated successfully and report lower bills. We should consider it." },
  { id: "d08", topic: "migrating the data warehouse to a lakehouse", complete: true, quality: 2,
    draft: "For: cheaper storage and one copy of the data. Against: slower interactive queries and a large dashboard migration. Recommendation: pilot with the ML team first." },
  { id: "d09", topic: "requiring code review for all infrastructure changes", complete: true, quality: 3,
    draft: "Case for: the last three incidents came from unreviewed config changes; review would have caught two of them, and peers report 40% fewer change-related incidents after mandating it. Risks: median change lead time grows from 20 minutes to about 2 hours, and on-call fixes need an emergency path. Recommendation: require review with a documented break-glass procedure audited weekly." },
  { id: "d10", topic: "requiring code review for all infrastructure changes", complete: false, quality: 0,
    draft: "Code review is a widely used practice. Many teams do it. It has pros and cons." },
  { id: "d11", topic: "requiring code review for all infrastructure changes", complete: false, quality: 1,
    draft: "Risks: slower changes, reviewer fatigue, and blocked on-call fixes. The case for: fewer incidents and shared knowledge. Both sides have merit." },
  { id: "d12", topic: "requiring code review for all infrastructure changes", complete: true, quality: 2,
    draft: "For: fewer incidents from config mistakes. Against: slower lead time and on-call friction. Recommendation: mandate review but add a break-glass path." },
];
