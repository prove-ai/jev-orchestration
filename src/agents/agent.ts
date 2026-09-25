/**
 * Agents are tools. A generative model does work inside an `act` node; Jev only
 * decides between nodes. `agentTool` turns any Agent into a Tool whose prompt is a
 * template over the node's mapped args, and meters token usage into the run.
 */
import type { Tool } from "../runtime/engine.js";

export interface AgentUsage { input_tokens: number; output_tokens: number }
export interface AgentReply { text: string; usage?: AgentUsage; model?: string }

export interface Agent {
  readonly name: string;
  complete(input: { system?: string; prompt: string }): Promise<AgentReply>;
}

export interface AgentToolOptions {
  system?: string;
  /** Prompt template over the act node's args: "Summarize ${text} for ${audience}". */
  prompt: string;
}

export function agentTool(agent: Agent, opts: AgentToolOptions): Tool {
  return async (args, ctx) => {
    const prompt = renderTemplate(opts.prompt, args);
    const reply = await agent.complete({ system: opts.system, prompt });
    ctx.meter({ agent: agent.name, model: reply.model, usage: reply.usage });
    return reply.text;
  };
}

export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\$\{([\w.]+)\}/g, (_, path: string) => {
    let cur: unknown = vars;
    for (const p of path.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
    if (cur === undefined || cur === null) return "";
    return typeof cur === "string" ? cur : JSON.stringify(cur, null, 1);
  });
}

/** Deterministic stand-in for tests and keyless demos. */
export class MockAgent implements Agent {
  public calls: Array<{ system?: string; prompt: string }> = [];
  constructor(public readonly name: string, private readonly reply?: string | ((prompt: string, n: number) => string)) {}
  async complete(input: { system?: string; prompt: string }): Promise<AgentReply> {
    this.calls.push(input);
    const n = this.calls.length;
    const text = typeof this.reply === "function" ? this.reply(input.prompt, n)
      : this.reply ?? `[${this.name} #${n}] ${input.prompt.slice(0, 120)}`;
    return { text, usage: { input_tokens: Math.ceil(input.prompt.length / 4), output_tokens: Math.ceil(text.length / 4) }, model: "mock" };
  }
}
