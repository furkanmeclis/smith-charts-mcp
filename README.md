# smith-charts-mcp

<p align="center">
  <a href="https://github.com/furkanmeclis/smith-charts-mcp/actions/workflows/ci.yml"><img src="https://github.com/furkanmeclis/smith-charts-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/furkanmeclis/smith-charts-mcp/releases"><img src="https://img.shields.io/github/v/release/furkanmeclis/smith-charts-mcp?sort=semver" alt="Release"></a>
  <a href="https://github.com/furkanmeclis/smith-charts-mcp/pkgs/container/smith-charts-mcp"><img src="https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white" alt="Docker"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node ≥ 20">
  <img src="https://img.shields.io/badge/MCP-stdio%20%7C%20Streamable%20HTTP-6E56CF" alt="MCP transports">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/furkanmeclis/smith-charts-mcp" alt="MIT license"></a>
</p>

**A lightweight [Model Context Protocol](https://modelcontextprotocol.io) server for RF & microwave engineering, built around the Smith chart.**

Give Claude, Cursor or any MCP client the ability to convert impedances, analyze transmission lines and ladder circuits, synthesize L / Pi / T / stub / λ/4 matching networks, analyze transistor S-parameters (stability, gain, noise, conjugate match) and draw publication-quality Smith charts — with human-readable summaries in **English or Turkish**.

[Türkçe README](README.tr.md)

<p align="center">
  <img src="media/example-l-match.png" width="32%" alt="L-match on a Smith chart">
  <img src="media/example-lna.png" width="32%" alt="LNA gain and noise circles">
  <img src="media/example-stability.png" width="32%" alt="Stability circles">
</p>

- **14 tools · 7 prompts · 8 resources**
- **Runs anywhere**: local stdio, or as a remote **Streamable HTTP** server at `/mcp`. That lets you add it as a custom connector in Claude on **web, desktop and mobile**.
- **Lightweight**: 2 runtime dependencies (`@modelcontextprotocol/sdk`, `zod`) + optional `@resvg/resvg-js` for PNG. No browser, no web framework, no database.
- **Engineer-friendly input**: `"2.4GHz"`, `"10nH"`, `"1.5pF"`, `"4k7"`, `"25-j15"`, `"0.25λ"`, `"45deg"`, `"12mm"`.
- **Chainable**: every matching tool returns `components` in the exact format `analyze_circuit` and `render_smith_chart` accept. Design, verify and plot in three calls.
- **Verified math**: 66 tests, including textbook examples (Pozar). Every synthesized network is re-simulated before it is returned.

---

## Installation

### Hosted endpoint (no install, works on mobile)

Add **`https://smith-chart-mcp.technowide.software/mcp`** as a custom connector:
- Claude (web, desktop, iOS, Android): **Settings → Connectors → Add custom connector**.
- Any other client that supports remote Streamable HTTP MCP servers.

The hosted server always runs the latest release. Ask it `version_info` to see what changed.

### Local (stdio)

Requires Node.js ≥ 20.

### Claude Code

```bash
claude mcp add smith-charts -- npx -y smith-charts-mcp
```

### Claude Desktop / Cursor / Windsurf / VS Code

Add the server to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "smith-charts": {
      "command": "npx",
      "args": ["-y", "smith-charts-mcp"],
      "env": { "SMITH_CHARTS_MCP_LANG": "en" }
    }
  }
}
```

### From source

```bash
git clone https://github.com/furkanmeclis/smith-charts-mcp.git
cd smith-charts-mcp
npm install
npm run build
```

Then point your client at `node /absolute/path/to/smith-charts-mcp/dist/index.js`.

Inspect it interactively with `npm run inspect`, which opens the MCP Inspector.

### Remote server (Claude mobile, web and other devices)

Run the Streamable HTTP transport and put it behind HTTPS:

```bash
npm run build
PORT=3000 node dist/index.js --http          # → http://0.0.0.0:3000/mcp
# or with Docker
docker build -t smith-charts-mcp .
docker run -d -p 3000:3000 --restart unless-stopped smith-charts-mcp
```

Expose it through your reverse proxy, e.g. `https://smith-chart-mcp.example.com/mcp`. Then in Claude go to **Settings → Connectors → Add custom connector** and paste that URL. The connector then works in the mobile apps as well.

What the HTTP mode provides:
- **Stateless**: each request is self-contained, so you can run as many replicas as you like.
- **Endpoints**:
  - `GET /health`: liveness check.
  - `GET /`: info page.
  - `POST /mcp`: the MCP endpoint.
  - CORS is enabled.
- **Protection**: per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, default 120) and a 4 MB body limit.
- **No filesystem access**: `touchstone_path` and `output_path` are disabled, so clients cannot read or write files on your server. Pass Touchstone data as `touchstone_content` instead. Set `SMITH_CHARTS_MCP_ALLOW_FS=1` only on a private deployment.
- **Docker image**: includes the DejaVu fonts, so PNG labels render correctly on Linux.

---

## Tools

| Tool | What it does |
|---|---|
| `impedance_convert` | Converts Z, z, Y, Γ, VSWR or return loss into all the others: VSWR, return/mismatch loss, Q, and equivalent series/parallel L or C at a frequency. |
| `tline_input_impedance` | Zin of a lossy or lossless line with an electrical or physical length (εeff / velocity factor), Γ at load and input, and the positions of the voltage maxima and minima. |
| `analyze_circuit` | Cascades load → components → source. Returns Z, Γ and VSWR at every node, a frequency sweep, matched bandwidth and tolerance-corner analysis. |
| `design_l_match` | All L-section solutions, including complex source and load. Classifies each as low-pass or high-pass and reports DC behaviour, bandwidth and E-series rounding. |
| `design_pi_t_match` | Pi and T networks for a chosen loaded Q, with every low-pass, high-pass and mixed variant. |
| `design_stub_match` | Single-stub tuner (open or short, shunt or series), with lengths in λ, degrees and metres. |
| `design_quarter_wave` | λ/4 transformer. Complex loads are first rotated to the nearest voltage maximum or minimum. |
| `parse_touchstone` | Summarizes a `.s1p` or `.s2p` file (MA/DB/RI): per-frequency table, best match, K/μ, MAG/MSG, stable ranges and noise data. |
| `amplifier_stability` | Rollett K, \|Δ\|, μ and μ', plus source and load stability circles with their stable side. Can sweep a whole file. |
| `gain_circles` | Available, operating and unilateral constant-gain circles, with MAG/MSG or G_S,max / G_L,max as reference. |
| `noise_circles` | Constant noise-figure circles; also evaluates NF and available gain for a proposed source impedance. |
| `conjugate_match` | Simultaneous conjugate match: ΓS, ΓL, GT,max, MSG and U, plus ready-made input and output L-networks. |
| `version_info` | Running version, release notes for any version, and "what changed since X". Also reports runtime capabilities. |
| `render_smith_chart` | PNG/SVG Smith chart with impedance, admittance or combined grid and light or dark theme. Overlays include circuit arcs, sweeps, points, VSWR/Q circles, any circle, a Touchstone S11 locus, and amplifier stability (shaded), gain and noise circles. Can also save the image to a file. |

All tools accept `language: "en" | "tr"`. Results come back as a readable summary plus the full numeric JSON, which is also exposed as `structuredContent`.

### Circuit format

Components are listed **from the load towards the source**:

```json
{
  "load": { "z": "25-j15" },
  "frequency": "2.4GHz",
  "components": [
    { "type": "capacitor", "placement": "series", "value": "6.63pF" },
    { "type": "inductor",  "placement": "shunt",  "value": "3.32nH", "q": 40 }
  ],
  "sweep": { "span": "800MHz" },
  "bandwidth_vswr": 2
}
```

Element types:
- `inductor`, `capacitor`, `resistor`: support Q, ESR, ESL and tolerance.
- `rlc`: series or parallel combination.
- `impedance`: constant Z or a Z(f) table.
- `transmission_line`: lossy, with εeff or velocity factor.
- `stub`: open or short, shunt or series.
- `transformer` and `coupled_inductors`.

The load can be a constant `z`, a `gamma`, a `table`, or a measured **.s1p** file (`touchstone_path`), for example a VNA sweep of an antenna.

## Prompts

| Prompt | Workflow |
|---|---|
| `match_impedance` | Analyze the load, then design and compare every matching method, verify the best one, and plot it. |
| `design_amplifier` | From an `.s2p` file: stability, then the max-gain / low-noise / target-gain trade-off, then input and output networks. |
| `check_stability` | Stability report over frequency, with shaded stability circles. |
| `tune_antenna` | Tune a measured `.s1p` antenna at a target frequency and report the achieved bandwidth. |
| `explain_smith_chart` | Interactive Smith chart lesson (beginner, intermediate or advanced) with practice problems. |
| `solve_rf_problem` | Step-by-step homework solution, with every number cross-checked by the tools. |
| `transmission_line_problem` | Zin, standing waves and voltage maxima and minima for a terminated line. |

Every prompt takes a `language` argument (`en` / `tr`).

## Resources

- `smith://docs/formulas.en.md`, `smith://docs/formulas.tr.md`: formula sheet covering reflection, transmission lines, matching, stability, gain and noise.
- `smith://docs/components.en.md`, `smith://docs/components.tr.md`: circuit input format.
- `smith://changelog.en.md`, `smith://changelog.tr.md`: release history.
- `smith://examples/bjt-100m-2g.s2p`, `smith://examples/lna-1g4-noise.s2p`: example devices to experiment with.

## Example conversation

> **You:** Match a 25 − j15 Ω load to 50 Ω at 2.4 GHz. I need a DC block and standard E24 parts, and show me the Smith chart.
>
> **Claude** calls `design_l_match` (preference `dc_block`, `snap_to_series: "E24"`), then `analyze_circuit` with a sweep, then `render_smith_chart`. It answers with: *series C 6.63 pF → shunt L 3.32 nH (E24 parts: 6.8 pF and 3.3 nH give VSWR 1.01 at 2.4 GHz). VSWR stays ≤ 2 from about 1.5 GHz to beyond 4.6 GHz*, plus the chart above.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SMITH_CHARTS_MCP_LANG` | `en` | Default summary language (`en` or `tr`) when a call does not pass `language`. |
| `MCP_TRANSPORT` | `stdio` | Set to `http` to start the Streamable HTTP server (same as `--http`). |
| `PORT` / `HOST` / `MCP_PATH` | `3000` / `0.0.0.0` / `/mcp` | HTTP listen settings. |
| `RATE_LIMIT_PER_MINUTE` | `120` | HTTP requests per minute per client IP (`0` disables the limit). |
| `SMITH_CHARTS_MCP_ALLOW_FS` | off | Allow `touchstone_path` / `output_path` over HTTP. Enable only on trusted, private deployments. |
| `SMITH_CHARTS_MCP_FONT`, `SMITH_CHARTS_MCP_FONT_DIRS` | auto | Font family and extra font directories used for PNG text. |

PNG output uses the optional `@resvg/resvg-js` dependency. If it is unavailable, `render_smith_chart` returns SVG instead.

Every chart carries two marks:
- a faint `furkanmeclis/smith-charts-mcp` watermark;
- a QR code in the free bottom-right corner that links to this repository.

The QR is pre-generated at build time, so it adds no runtime dependency. To regenerate it for a fork, run `npm run gen:qr -- <url>`.

## Development

```bash
npm install
npm test          # node --test, runs the TypeScript sources directly (Node ≥ 22.18)
npm run typecheck
npm run build     # → dist/
npm run dev       # run the server from source (stdio)
npm run dev:http  # … or over HTTP on :3000/mcp
```

The project layout:
- `src/core`: pure math, no MCP dependency.
- `src/render`: SVG and PNG chart rendering.
- `src/tools`: MCP tool definitions.
- `src/prompts` and `src/resources`.

## Versioning & releases

The project follows [Semantic Versioning](https://semver.org/). Release notes live in [CHANGELOG.md](CHANGELOG.md) and inside the server itself: ask *"which version are you and what changed?"* and the model calls `version_info`.

Pushing a `vX.Y.Z` tag runs the release workflow, which:
- verifies the version and runs the tests;
- publishes the GitHub release;
- publishes the multi-arch image `ghcr.io/furkanmeclis/smith-charts-mcp`;
- redeploys the hosted endpoint.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full release steps.

## Contributing

Issues and pull requests are welcome, in English or Turkish. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

MIT © Furkan Meclis
