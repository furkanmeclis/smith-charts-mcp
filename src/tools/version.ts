import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CHANGELOG, compareVersions, entryMarkdown } from "../changelog.ts";
import { filesystemAllowed } from "../config.ts";
import { resolveLang, t } from "../i18n/index.ts";
import { QR_URL } from "../render/qr-data.ts";
import { pngAvailable } from "../render/png.ts";
import { VERSION } from "../version.ts";
import { defineTool, ok } from "./format.ts";
import { InputError, languageSchema } from "./schemas.ts";

export function registerVersionTool(server: McpServer): void {
  defineTool(
    server,
    "version_info",
    {
      title: "Server version & changelog",
      description: [
        "Report which version of smith-charts-mcp is running and what changed between versions.",
        "Without arguments: current version, release date and its release notes.",
        "version: notes of one specific release. since: every change released after that version (e.g. 'what changed since 0.1.0?').",
        "all: the full history. Also reports runtime capabilities (PNG rendering, filesystem access).",
      ].join(" "),
      inputSchema: {
        version: z.string().optional().describe("Show the notes of this exact version, e.g. '0.1.0'."),
        since: z.string().optional().describe("Show all releases newer than this version."),
        all: z.boolean().optional().describe("Return the complete history."),
        language: languageSchema,
      },
    },
    async (a) => {
      const lang = resolveLang(a.language);
      let entries = [CHANGELOG[0]];
      if (a.all) entries = CHANGELOG;
      else if (a.version) {
        const e = CHANGELOG.find((x) => compareVersions(x.version, a.version as string) === 0);
        if (!e) throw new InputError(`Unknown version ${a.version}. Known: ${CHANGELOG.map((x) => x.version).join(", ")}`);
        entries = [e];
      } else if (a.since) entries = CHANGELOG.filter((x) => compareVersions(x.version, a.since as string) > 0);

      const header = t(
        lang,
        `smith-charts-mcp v${VERSION} (released ${CHANGELOG[0].date}). ${CHANGELOG.length} release(s) in history.`,
        `smith-charts-mcp v${VERSION} (yayın tarihi ${CHANGELOG[0].date}). Geçmişte ${CHANGELOG.length} sürüm var.`,
      );
      const body =
        entries.length === 0
          ? t(lang, `No releases after ${a.since}: you are up to date.`, `${a.since} sonrasında yeni sürüm yok: güncelsiniz.`)
          : entries.map((e) => entryMarkdown(e, lang, 3)).join("\n");
      return ok(`${header}\n\n${body}`, {
        name: "smith-charts-mcp",
        version: VERSION,
        latest_release: CHANGELOG[0].version,
        repository: QR_URL,
        capabilities: { png_rendering: await pngAvailable(), filesystem_access: filesystemAllowed() },
        releases: entries.map((e) => ({
          version: e.version,
          date: e.date,
          summary: e.summary[lang],
          added: e.added?.map((i) => i[lang]) ?? [],
          changed: e.changed?.map((i) => i[lang]) ?? [],
          fixed: e.fixed?.map((i) => i[lang]) ?? [],
          security: e.security?.map((i) => i[lang]) ?? [],
        })),
      });
    },
  );
}
