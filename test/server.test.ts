import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PROMPT_NAMES } from "../src/prompts/index.ts";
import { _examples, RESOURCE_URIS } from "../src/resources/index.ts";
import { createServer } from "../src/server.ts";
import { VERSION } from "../src/version.ts";

let client: Client;
const tmp = mkdtempSync(join(tmpdir(), "smith-mcp-"));
const s2pPath = join(tmp, "bjt.s2p");
const lnaPath = join(tmp, "lna.s2p");
const s1pPath = join(tmp, "antenna.s1p");

// synthetic antenna: series RLC (R=40, L=200nH, C) resonant near 10 MHz, sampled 8–12 MHz
function antennaS1p(): string {
  const lines = ["# MHz S RI R 50"];
  const L = 2e-7;
  const C = 1 / ((2 * Math.PI * 10e6) ** 2 * L);
  for (let f = 8; f <= 12.0001; f += 0.25) {
    const w = 2 * Math.PI * f * 1e6;
    const zr = 40;
    const zi = w * L - 1 / (w * C) + 30;
    const den = (zr + 50) ** 2 + zi ** 2;
    const gr = ((zr - 50) * (zr + 50) + zi * zi) / den;
    const gi = (zi * (zr + 50) - (zr - 50) * zi) / den;
    lines.push(`${f.toFixed(2)} ${gr} ${gi}`);
  }
  return lines.join("\n");
}

type ToolResult = { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, unknown> };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (r.isError) assert.fail(`${name} failed: ${r.content[0]?.text}`);
  return r;
}

before(async () => {
  writeFileSync(s2pPath, _examples.EXAMPLE_STABILITY_S2P);
  writeFileSync(lnaPath, _examples.EXAMPLE_LNA_S2P);
  writeFileSync(s1pPath, antennaS1p());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(ct);
});

after(async () => {
  await client.close();
});

describe("discovery", () => {
  it("lists all tools with titles, descriptions and object schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "amplifier_stability",
      "analyze_circuit",
      "conjugate_match",
      "design_l_match",
      "design_pi_t_match",
      "design_quarter_wave",
      "design_stub_match",
      "gain_circles",
      "impedance_convert",
      "noise_circles",
      "parse_touchstone",
      "render_smith_chart",
      "tline_input_impedance",
      "version_info",
    ]);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 80, `${t.name} description too short`);
      assert.ok(t.title);
      assert.equal(t.inputSchema.type, "object");
      assert.ok(t.inputSchema.properties && "language" in t.inputSchema.properties, `${t.name} lacks language`);
    }
  });
  it("lists prompts and resources", async () => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), [...PROMPT_NAMES].sort());
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri).sort(), [...RESOURCE_URIS].sort());
  });
});

describe("tools", () => {
  it("impedance_convert", async () => {
    const r = await call("impedance_convert", { z: "100", z0: 50, frequency: "1GHz" });
    assert.equal(r.structuredContent?.vswr, 2);
    const tr = await call("impedance_convert", { vswr: 3, gamma_angle_deg: 90, language: "tr" });
    assert.match(tr.content[0].text as string, /Geri dönüş kaybı/);
  });

  it("tline_input_impedance", async () => {
    const r = await call("tline_input_impedance", { load: "100", length: "0.25λ" });
    const zin = (r.structuredContent?.input as { z: { re: number } }).z;
    assert.ok(Math.abs(zin.re - 25) < 1e-6);
    const open = await call("tline_input_impedance", { load_type: "open", length: "0.125λ" });
    const z2 = (open.structuredContent?.input as { z: { re: number; im: number } }).z;
    assert.ok(Math.abs(z2.im + 50) < 1e-6, `open λ/8 should be -j50, got ${JSON.stringify(z2)}`);
  });

  it("design_l_match → analyze_circuit chain", async () => {
    const r = await call("design_l_match", { load: { z: "25-j15" }, frequency: "2.4GHz", snap_to_series: "E24" });
    const sols = r.structuredContent?.solutions as { components: unknown[]; verification: { vswr: number } }[];
    assert.ok(sols.length >= 2);
    for (const s of sols) assert.ok(s.verification.vswr < 1.0001);
    const a = await call("analyze_circuit", {
      load: { z: "25-j15" },
      components: sols[0].components,
      frequency: "2.4GHz",
      sweep: { span: "1GHz", points: 51 },
      bandwidth_vswr: 2,
    });
    const input = a.structuredContent?.input as { vswr: number };
    assert.ok(input.vswr < 1.001, `chained VSWR ${input.vswr}`);
    assert.ok(a.structuredContent?.bandwidth);
  });

  it("design_l_match removes duplicate networks", async () => {
    const r = await call("design_l_match", { load: { z: "10+j20" }, frequency: "915MHz" });
    const d = (r.structuredContent?.solutions as { description: string }[]).map((x) => x.description);
    assert.equal(new Set(d).size, d.length);
    assert.equal(d.length, 2);
  });

  it("analyze_circuit tolerance + s1p load", async () => {
    const r = await call("analyze_circuit", {
      load: { touchstone_path: s1pPath },
      components: [{ type: "capacitor", placement: "series", value: "100pF", tolerance_pct: 5 }],
      frequency: "10MHz",
    });
    assert.ok((r.structuredContent?.tolerance as { corners_evaluated: number }).corners_evaluated === 2);
  });

  it("design_pi_t_match", async () => {
    const r = await call("design_pi_t_match", { load: { z: 10 }, frequency: "100MHz", q: 4 });
    assert.equal((r.structuredContent?.solutions as unknown[]).length, 8);
  });

  it("design_stub_match & design_quarter_wave", async () => {
    const s = await call("design_stub_match", { load: { z: "60-j80" }, frequency: "1GHz", velocity_factor: 0.7 });
    assert.equal((s.structuredContent?.solutions as unknown[]).length, 4);
    const qw = await call("design_quarter_wave", { load: { z: "40+j30" }, language: "tr" });
    assert.match(qw.content[0].text as string, /λ\/4/);
  });

  it("parse_touchstone + amplifier tools", async () => {
    const p = await call("parse_touchstone", { touchstone_path: s2pPath });
    assert.equal(p.structuredContent?.ports, 2);
    const st = await call("amplifier_stability", { device: { touchstone_path: s2pPath } });
    assert.ok(Array.isArray(st.structuredContent?.rows));
    const st1 = await call("amplifier_stability", { device: { touchstone_path: s2pPath }, frequency: "1.4GHz" });
    assert.ok("load_plane_circle" in (st1.structuredContent ?? {}));
    const g = await call("gain_circles", { device: { touchstone_path: lnaPath }, frequency: "1.4GHz", type: "unilateral_source", gains_db: [0, 1] });
    assert.equal((g.structuredContent?.circles as unknown[]).length, 2);
    const n = await call("noise_circles", { device: { touchstone_path: lnaPath }, frequency: "1.4GHz", source_impedance: "50" });
    assert.ok((n.structuredContent?.evaluated_source as { nf_db: number }).nf_db > 1.6);
    const cm = await call("conjugate_match", {
      device: {
        s11: { mag: 0.72, angle_deg: -116 },
        s21: { mag: 2.6, angle_deg: 76 },
        s12: { mag: 0.03, angle_deg: 57 },
        s22: { mag: 0.73, angle_deg: -54 },
      },
      frequency: "4GHz",
    });
    assert.ok(cm.structuredContent?.feasible);
    assert.ok(Array.isArray(cm.structuredContent?.input_networks));
  });

  it("render_smith_chart returns a PNG and saves files", async () => {
    const out = join(tmp, "chart.png");
    const r = await call("render_smith_chart", {
      title: "Test",
      format: "both",
      output_path: out,
      circuit: {
        load: { z: "25-j15" },
        components: [
          { type: "inductor", placement: "series", value: "1nH" },
          { type: "capacitor", placement: "shunt", value: "1pF" },
        ],
        frequency: "2.4GHz",
        sweep: { span: "500MHz" },
      },
      points: [{ z: "50", label: "Match" }],
      vswr_circles: [2],
      q_contours: [1],
      amplifier: { device: { touchstone_path: lnaPath }, frequency: "1.4GHz", available_gain_db: [10], noise_figure_db: [2] },
    });
    const img = r.content.find((c) => c.type === "image");
    assert.ok(img?.data && img.data.length > 1000, "expected png data");
    assert.ok(r.content.some((c) => c.type === "text" && c.text?.startsWith("<svg")));
    assert.ok(readFileSync(out).subarray(1, 4).toString() === "PNG");
    assert.ok(readFileSync(join(tmp, "chart.svg"), "utf8").includes("</svg>"));
  });

  it("version_info reports version and history", async () => {
    const r = await call("version_info", {});
    assert.equal(r.structuredContent?.version, VERSION);
    const since = await call("version_info", { since: VERSION, language: "tr" });
    assert.equal((since.structuredContent?.releases as unknown[]).length, 0);
    assert.match(since.content[0].text as string, /güncelsiniz/);
    const bad = (await client.callTool({ name: "version_info", arguments: { version: "9.9.9" } })) as ToolResult;
    assert.ok(bad.isError);
  });

  it("returns isError for invalid input", async () => {
    const r = (await client.callTool({ name: "impedance_convert", arguments: { z: "abc" } })) as ToolResult;
    assert.ok(r.isError);
    assert.match(r.content[0].text as string, /Invalid input/);
  });
});

describe("prompts & resources", () => {
  it("renders every prompt in both languages", async () => {
    const args: Record<string, Record<string, string>> = {
      match_impedance: { load: "25-j15", frequency: "2.4GHz" },
      design_amplifier: { touchstone_path: s2pPath, frequency: "1GHz" },
      check_stability: { touchstone_path: s2pPath },
      tune_antenna: { touchstone_path: s1pPath, frequency: "10MHz" },
      explain_smith_chart: {},
      solve_rf_problem: { problem: "A 100 Ω load on a 50 Ω line; find VSWR." },
      transmission_line_problem: { load: "100+j50", length: "0.3λ" },
    };
    for (const name of PROMPT_NAMES) {
      for (const language of ["en", "tr"]) {
        const p = await client.getPrompt({ name, arguments: { ...args[name], language } });
        const text = (p.messages[0].content as { text: string }).text;
        assert.ok(text.length > 200);
        if (language === "tr") assert.match(text, /Türkçe/);
      }
    }
  });
  it("reads resources", async () => {
    for (const uri of RESOURCE_URIS) {
      const r = await client.readResource({ uri });
      assert.ok((r.contents[0] as { text: string }).text.length > 100);
    }
  });
});
