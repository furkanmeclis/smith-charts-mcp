# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-05

First public release: Smith chart, impedance-matching and S-parameter toolkit over stdio and Streamable HTTP.

### Added

- impedance_convert and tline_input_impedance: Z / z / Y / Γ / VSWR / return-loss conversion and lossy transmission-line input impedance with voltage max/min positions.
- analyze_circuit: load → source ladder analysis (L, C, R with Q/ESR/ESL, RLC, Z(f) tables, lines, stubs, transformers, coupled inductors) with sweeps, matched bandwidth and tolerance corners; .s1p loads supported.
- Matching synthesis: design_l_match, design_pi_t_match, design_stub_match and design_quarter_wave with verification, bandwidth and E-series rounding; results chain into analyze_circuit and render_smith_chart.
- Amplifier tools: parse_touchstone, amplifier_stability (K, Δ, μ, stability circles), gain_circles, noise_circles and conjugate_match with ready-made L-networks.
- render_smith_chart: PNG/SVG charts (Z, Y or ZY grid, light/dark) with circuit arcs, sweeps, points, VSWR/Q circles, Touchstone loci and shaded stability, gain and noise circles; watermark and repository QR code on every chart.
- version_info tool and smith://changelog resources to ask the server what changed between versions.
- 7 guided prompts (matching, amplifier design, stability, antenna tuning, Smith chart lesson, homework solver, transmission lines) and bilingual reference resources.
- English and Turkish summaries on every tool and prompt (language argument or SMITH_CHARTS_MCP_LANG).
- Stateless Streamable HTTP transport at /mcp (health check, CORS, rate limit) and a Docker image, so the server works as a remote connector on mobile and web.

### Security

- touchstone_path and output_path are disabled over HTTP unless SMITH_CHARTS_MCP_ALLOW_FS is set, so remote clients cannot read or write server files.
