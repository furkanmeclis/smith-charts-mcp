import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { QR_URL } from "./render/qr-data.ts";
import { createServer, SERVER_NAME } from "./server.ts";
import { VERSION } from "./version.ts";

export interface HttpOptions {
  port: number;
  host: string;
  /** Path of the MCP endpoint, default /mcp */
  path: string;
  /** Requests per minute per client IP; 0 disables the limiter */
  rateLimitPerMinute: number;
  maxBodyBytes: number;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": `${type}; charset=utf-8` }).end(text);
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Fixed one-minute window per IP; enough to stop accidental floods without extra dependencies. */
function rateLimiter(limit: number) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (ip: string): boolean => {
    if (limit <= 0) return true;
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.windowStart >= 60_000) {
      hits.set(ip, { windowStart: now, count: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.windowStart >= 60_000) hits.delete(k);
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function landingPage(path: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVER_NAME}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1f2933}code{background:#f1f3f5;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>${SERVER_NAME} <small>v${VERSION}</small></h1>
<p>Model Context Protocol server for Smith charts, impedance matching and S-parameter analysis.</p>
<p>MCP endpoint (Streamable HTTP): <code>${path}</code></p>
<p>Add it as a custom connector in Claude (web, desktop or mobile) using this page's URL + <code>${path}</code>.</p>
<p><a href="${QR_URL}">${QR_URL}</a></p></body></html>`;
}

/**
 * Stateless Streamable HTTP server: every POST gets a fresh MCP server + transport, so the process holds
 * no per-client state and can be scaled horizontally behind any proxy.
 */
export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const allow = rateLimiter(opts.rateLimitPerMinute);
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS).end();
        return;
      }
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        send(res, 200, { status: "ok", name: SERVER_NAME, version: VERSION });
        return;
      }
      if (url.pathname === "/" && req.method === "GET") {
        send(res, 200, landingPage(opts.path), "text/html");
        return;
      }
      if (url.pathname !== opts.path) {
        send(res, 404, { error: "Not found", mcp_endpoint: opts.path });
        return;
      }
      if (req.method !== "POST") {
        // stateless server: no standalone SSE stream and no sessions to delete
        res.setHeader("Allow", "POST, OPTIONS");
        send(res, 405, jsonRpcError(-32000, "Method not allowed. Use POST (stateless Streamable HTTP)."));
        return;
      }
      if (!allow(clientIp(req))) {
        res.setHeader("Retry-After", "60");
        send(res, 429, jsonRpcError(-32000, "Rate limit exceeded, retry in a minute."));
        return;
      }
      const body = await readJson(req, opts.maxBodyBytes);
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) send(res, status, jsonRpcError(status === 500 ? -32603 : -32700, (e as Error).message));
      if (status === 500) console.error("[smith-charts-mcp] request failed:", e);
    }
  });
  return new Promise((resolve) => http.listen(opts.port, opts.host, () => resolve(http)));
}
