import Anthropic from "@anthropic-ai/sdk";
import type { Agent, AgentReply } from "./agent.js";

export interface ClaudeAgentOptions {
  model?: string;                 // default claude-opus-5
  maxTokens?: number;             // default 8000
  effort?: "low" | "medium" | "high" | "xhigh" | "max";  // default low: agents here are workers, not planners
  client?: Anthropic;
}

/** One Claude call per act node. Credentials come from ANTHROPIC_API_KEY or an `ant auth login` profile. */
export class ClaudeAgent implements Agent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: NonNullable<ClaudeAgentOptions["effort"]>;

  constructor(public readonly name: string, opts: ClaudeAgentOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.CLAUDE_AGENT_MODEL ?? "claude-opus-5";
    this.maxTokens = opts.maxTokens ?? 8000;
    this.effort = opts.effort ?? "low";
  }

  async complete(input: { system?: string; prompt: string }): Promise<AgentReply> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: input.system,
      output_config: { effort: this.effort },
      messages: [{ role: "user", content: input.prompt }],
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`agent "${this.name}" refused: ${res.stop_details?.explanation ?? res.stop_details?.category ?? "no detail"}`);
    }
    if (res.stop_reason === "max_tokens") {
      throw new Error(`agent "${this.name}" hit max_tokens (${this.maxTokens}); raise maxTokens`);
    }
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    return { text, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model };
  }
}
