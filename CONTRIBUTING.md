# Contributing

Thanks for your interest in **smith-charts-mcp**! Bug reports, new RF tools, better formulas and translations are all welcome.
Türkçe katkılar da memnuniyetle karşılanır — issue ve PR'ları Türkçe veya İngilizce açabilirsiniz.

## Development setup

```bash
git clone https://github.com/furkanmeclis/smith-charts-mcp.git
cd smith-charts-mcp
npm install
npm test          # Node ≥ 22.18 runs the TypeScript sources directly
npm run dev       # stdio server from source
npm run dev:http  # HTTP server on http://localhost:3000/mcp
npm run inspect   # MCP Inspector against the built server (run npm run build first)
```

## Project layout

| Path | Contents |
|---|---|
| `src/core/` | Pure RF math (complex numbers, units, circuits, matching, S-parameters). No MCP imports. |
| `src/render/` | Dependency-free SVG Smith chart, optional PNG via resvg, pre-generated QR code. |
| `src/tools/` | MCP tool definitions: zod input schemas, bilingual summaries, JSON results. |
| `src/prompts/`, `src/resources/` | Guided prompts and reference documents (EN + TR). |
| `src/http.ts`, `src/index.ts` | Streamable HTTP and stdio entry points. |
| `src/changelog.ts` | Release history — single source for `CHANGELOG.md` and the `version_info` tool. |
| `test/` | `node:test` suites: math, MCP end-to-end, HTTP, release consistency. |

## Guidelines

- **Correctness first.** Every calculation change needs a test, ideally against a published reference
  (textbook example, simulator result). Matching tools must re-simulate their own output.
- **Keep it lightweight.** Avoid new runtime dependencies; dev-only tooling is fine.
- **Bilingual output.** User-facing summary text uses `t(lang, english, turkish)`; keep JSON keys in English.
- **Chainable results.** Tools that produce circuits return `components` in the `analyze_circuit` input format.
- **Descriptions matter.** Tool and parameter descriptions are what the model reads — be precise and give examples.

## Commit messages

Use the imperative mood and explain *why* in the body when it is not obvious
(e.g. `Fix stub length for series open stubs`). [Conventional Commits](https://www.conventionalcommits.org/) prefixes are welcome but optional.

## Releasing (maintainers)

1. Bump the version in `package.json`, `src/version.ts` and `server.json` (`npm test` checks they match).
2. Add an entry at the top of `src/changelog.ts` (English + Turkish), then run `npm run changelog`.
3. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The **Release** workflow verifies the tag, creates the GitHub release from `CHANGELOG.md`, publishes the Docker image
   to GHCR (and to npm when `NPM_TOKEN` is configured). The production server redeploys automatically on the new tag.
