import type { Jev, JevRequest, JevResponse, Question } from "./types.js";

export interface HttpJevOptions {
  apiKey: string;
  baseUrl?: string;                         // default TypeSafe; set to https://jev-agent.com/api/v1/systemone for the free host
  model?: string;                           // jev-latest | jev-preview | jev-1.13.0
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export class JevHttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`jev http ${status}: ${body.slice(0, 300)}`);
  }
}

export class HttpJev implements Jev {
  private readonly url: string;
  private readonly model: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(private readonly opts: HttpJevOptions) {
    this.url = opts.baseUrl ?? "https://api.typesafe.ai/v1/systemone";
    this.model = opts.model ?? "jev-latest";
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
    const body: JevRequest = { model: this.model, state, questions };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.f(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) throw new JevHttpError(res.status, text);
        if (!res.ok) throw new JevHttpError(res.status, text);
        const json = JSON.parse(text) as JevResponse;
        for (const id of Object.keys(questions)) {
          if (!json.answers?.[id]) throw new Error(`jev response missing answer for "${id}"`);
        }
        return json;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof JevHttpError ? e.status === 429 || e.status >= 500 : true;
        if (!retryable || attempt === this.retries) break;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr;
  }
}

export function jevFromEnv(env: NodeJS.ProcessEnv = process.env): HttpJev {
  const apiKey = env.JEV_API_KEY;
  if (!apiKey) throw new Error("JEV_API_KEY is not set");
  return new HttpJev({ apiKey, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL });
}
