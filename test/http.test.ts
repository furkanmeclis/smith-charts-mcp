import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { setFilesystemAccess } from "../src/config.ts";
import { startHttpServer } from "../src/http.ts";
import { QR_URL } from "../src/render/qr-data.ts";
import { renderSmithSvg } from "../src/render/svg.ts";

let base: string;
let close: () => Promise<void>;

before(async () => {
  setFilesystemAccess(false);
  const http = await startHttpServer({ port: 0, host: "127.0.0.1", path: "/mcp", rateLimitPerMinute: 1000, maxBodyBytes: 1_000_000 });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise((r) => http.close(() => r()));
});

after(async () => {
  setFilesystemAccess(true);
  await close();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

describe("streamable HTTP transport", () => {
  it("serves tools, prompts and resources over /mcp", async () => {
    const client = await connect();
    assert.equal((await client.listTools()).tools.length, 14);
    assert.equal((await client.listPrompts()).prompts.length, 7);
    const r = (await client.callTool({ name: "impedance_convert", arguments: { z: "100", language: "tr" } })) as {
      content: { text: string }[];
    };
    assert.match(r.content[0].text, /VSWR = 2/);
    await client.close();
  });

  it("returns a PNG chart over HTTP", async () => {
    const client = await connect();
    const r = (await client.callTool({ name: "render_smith_chart", arguments: { points: [{ z: "25-j15" }], png_scale: 1 } })) as {
      content: { type: string; data?: string }[];
    };
    assert.ok(r.content.some((c) => c.type === "image" && (c.data?.length ?? 0) > 1000));
    await client.close();
  });

  it("blocks filesystem access on the remote server", async () => {
    const client = await connect();
    const r = (await client.callTool({ name: "parse_touchstone", arguments: { touchstone_path: "/etc/passwd" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.ok(r.isError);
    assert.match(r.content[0].text, /disabled on this remote server/);
    const w = (await client.callTool({ name: "render_smith_chart", arguments: { output_path: "/tmp/x.png", format: "svg" } })) as {
      isError?: boolean;
    };
    assert.ok(w.isError);
    await client.close();
  });

  it("health, landing page, CORS and method handling", async () => {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.equal(((await h.json()) as { status: string }).status, "ok");
    assert.match(await (await fetch(`${base}/`)).text(), /\/mcp/);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    const pre = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    const bad = await fetch(`${base}/mcp`, { method: "POST", body: "{nope", headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 400);
  });

  it("rate-limits per IP", async () => {
    const http = await startHttpServer({ port: 0, host: "127.0.0.1", path: "/mcp", rateLimitPerMinute: 2, maxBodyBytes: 1000 });
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    const codes = [(await post()).status, (await post()).status, (await post()).status];
    assert.equal(codes[2], 429);
    await new Promise<void>((r) => http.close(() => r()));
  });
});

describe("chart branding", () => {
  it("embeds the watermark and a scannable QR code", async () => {
    const svg = renderSmithSvg({ size: 400, theme: "dark", grid: "both", z0: 50, show_labels: true, show_legend: true }, {});
    assert.match(svg, /furkanmeclis\/smith-charts-mcp/);
    let Resvg: (typeof import("@resvg/resvg-js"))["Resvg"];
    try {
      ({ Resvg } = await import("@resvg/resvg-js"));
    } catch {
      return; // optional dependency missing: SVG check above is enough
    }
    const { default: jsQR } = await import("jsqr");
    const img = new Resvg(svg, { fitTo: { mode: "width", value: 400 } }).render();
    const decoded = jsQR(new Uint8ClampedArray(img.pixels), img.width, img.height);
    assert.equal(decoded?.data, QR_URL);
  });
});
