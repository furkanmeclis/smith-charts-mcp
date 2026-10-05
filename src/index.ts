#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { setFilesystemAccess } from "./config.ts";
import { startHttpServer } from "./http.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag("--version") || flag("-v")) {
  console.log(VERSION);
  process.exit(0);
}
if (flag("--help") || flag("-h")) {
  console.log(`smith-charts-mcp ${VERSION}
Model Context Protocol server for Smith charts, impedance matching and S-parameter analysis.

Usage:
  smith-charts-mcp                      stdio transport (Claude Desktop / Code, Cursor, …)
  smith-charts-mcp --http [--port 3000] Streamable HTTP transport at /mcp (remote / mobile clients)

Options (HTTP):
  --port <n>        listen port            (env PORT, default 3000)
  --host <addr>     listen address         (env HOST, default 0.0.0.0)
  --path <p>        MCP endpoint path      (env MCP_PATH, default /mcp)

Environment:
  SMITH_CHARTS_MCP_LANG=en|tr            default summary language
  MCP_TRANSPORT=http                     same as --http
  RATE_LIMIT_PER_MINUTE=120              HTTP requests per minute per IP (0 = off)
  SMITH_CHARTS_MCP_ALLOW_FS=1            allow touchstone_path / output_path over HTTP (off by default)`);
  process.exit(0);
}

const env = process.env;
const useHttp = flag("--http") || env.MCP_TRANSPORT === "http";

if (useHttp) {
  setFilesystemAccess(env.SMITH_CHARTS_MCP_ALLOW_FS === "1" || env.SMITH_CHARTS_MCP_ALLOW_FS === "true");
  const opts = {
    port: Number(value("--port") ?? env.PORT ?? 3000),
    host: value("--host") ?? env.HOST ?? "0.0.0.0",
    path: value("--path") ?? env.MCP_PATH ?? "/mcp",
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
    maxBodyBytes: 4 * 1024 * 1024,
  };
  const http = await startHttpServer(opts);
  console.error(`smith-charts-mcp ${VERSION} listening on http://${opts.host}:${opts.port}${opts.path}`);
  const stop = () => http.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
