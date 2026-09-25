import { createServer, type ServerResponse } from "node:http";
import type { RunState } from "../spec/state.js";
import type { Workflow } from "../spec/workflow.js";
import type { EventSink, RunEvent } from "../runtime/events.js";
import { SHOWCASE_V4 } from "./showcase-v4.js";
import { SHOWCASE_V5 } from "./showcase-v5.js";
import { PAGE } from "./page.js";
import { SHOWCASE } from "./showcase.js";
import { SHOWCASE_V2 } from "./showcase-v2.js";
import { SHOWCASE_V3, SHOWCASE_V3_IMAGE } from "./showcase-v3.js";

interface RunRecord { id: string; workflow: Workflow; parent: string | null; state: RunState | null; events: RunEvent[] }

export interface LiveServer {
  port: number;
  url: string;
  /** Returns an event sink that knows these workflows (root and any sub-workflows); wire it into EngineOptions.onEvent. */
  sink(workflows: Workflow | Workflow[]): EventSink;
  close(): Promise<void>;
}

export async function startLiveServer(opts: { port?: number; host?: string } = {}): Promise<LiveServer> {
  const host = opts.host ?? "127.0.0.1";
  const runs = new Map<string, RunRecord>();
  const order: string[] = [];
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (url.pathname === "/showcase" || url.pathname === "/showcase/v1") return send(res, 200, SHOWCASE, "text/html; charset=utf-8");
    if (url.pathname === "/showcase/v2") return send(res, 200, SHOWCASE_V2, "text/html; charset=utf-8");
    if (url.pathname === "/showcase/v3") return send(res, 200, SHOWCASE_V3, "text/html; charset=utf-8");
    if (url.pathname === "/showcase/v3/image.svg") return send(res, 200, SHOWCASE_V3_IMAGE, "image/svg+xml");
    if (url.pathname === "/showcase/v4") return send(res, 200, SHOWCASE_V4, "text/html; charset=utf-8");
    if (url.pathname === "/showcase/v5") return send(res, 200, SHOWCASE_V5, "text/html; charset=utf-8");
    if (url.pathname === "/api/runs") {
      const list = order.slice().reverse().map((id) => {
        const r = runs.get(id)!;
        return { id, workflow: r.workflow.name, parent: r.parent, status: r.state?.run.status ?? "running", started_at: r.state?.run.started_at ?? null };
      });
      return send(res, 200, JSON.stringify(list), "application/json");
    }
    const m = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (m) {
      let id: string;
      try { id = decodeURIComponent(m[1]); } catch { return send(res, 400, "invalid run id", "text/plain"); }
      const r = runs.get(id);
      if (!r) return send(res, 404, "not found", "text/plain");
      return send(res, 200, JSON.stringify({ id: r.id, workflow: r.workflow, state: r.state, events: r.events.filter((e) => e.type !== "state") }), "application/json");
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    send(res, 404, "not found", "text/plain");
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4343, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 4343);

  return {
    port,
    url: `http://${host}:${port}`,
    sink(workflows) {
      const list = Array.isArray(workflows) ? workflows : [workflows];
      const byName = new Map(list.map((w) => [w.name, w]));
      return (e) => {
        let r = runs.get(e.run_id);
        if (!r) {
          const name = e.type === "run.start" ? e.workflow : list[0].name;
          const workflow = byName.get(name) ?? list[0];
          r = { id: e.run_id, workflow, parent: e.type === "run.start" ? e.parent : null, state: null, events: [] };
          runs.set(e.run_id, r); order.push(e.run_id);
        }
        if (e.type === "state") r.state = e.state; else r.events.push(e);
        const line = `data: ${JSON.stringify(e)}\n\n`;
        for (const c of clients) c.write(line);
      };
    },
    close: () => new Promise((resolve) => { for (const c of clients) c.end(); server.close(() => resolve()); }),
  };
}

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}
