import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import { abs, argDeg, type Complex, round } from "../core/complex.ts";
import { InputError } from "./schemas.ts";

/** JSON-friendly complex: rectangular + polar, rounded. */
export const cx = (z: Complex, digits = 6) => ({
  re: round(z.re, digits),
  im: round(z.im, digits),
  mag: round(abs(z), digits),
  angle_deg: round(argDeg(z), digits),
});

/** Plain {re, im} for compact tables. */
export const ri = (z: Complex, digits = 6) => ({ re: round(z.re, digits), im: round(z.im, digits) });

export const r6 = (x: number) => round(x, 6);

const replacer = (_k: string, v: unknown) => {
  if (typeof v === "number" && !Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
  return v;
};

export const toJson = (data: unknown): string => JSON.stringify(data, replacer, 1);

export function ok(summary: string, data: Record<string, unknown>, extra: CallToolResult["content"] = []): CallToolResult {
  const json = JSON.parse(toJson(data)) as Record<string, unknown>;
  return {
    content: [{ type: "text", text: `${summary}\n\n\`\`\`json\n${toJson(data)}\n\`\`\`` }, ...extra],
    structuredContent: json,
  };
}

export function fail(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = err instanceof InputError ? "Invalid input" : "Error";
  return { isError: true, content: [{ type: "text", text: `${prefix}: ${msg}` }] };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Registers a tool with uniform error handling and read-only annotations by default. */
export function defineTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
  handler: (args: { [K in keyof S]: import("zod").infer<S[K]> }) => Promise<CallToolResult> | CallToolResult,
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: { title: config.title, ...READ_ONLY, ...(config.readOnly === false ? { readOnlyHint: false } : {}) },
    },
    // the SDK callback type is generic over the schema; the handler signature above is the typed contract
    (async (args: never) => {
      try {
        return await handler(args);
      } catch (e) {
        return fail(e);
      }
    }) as never,
  );
}
