import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type Component,
  cascade,
  inputImpedance,
  matchedBandwidth,
  sweepFrequencies,
  toleranceCorners,
  vswrOf,
} from "../core/circuit.ts";
import { abs, format } from "../core/complex.ts";
import { gammaFromZ } from "../core/rf.ts";
import { formatSI } from "../core/units.ts";
import { resolveLang, t } from "../i18n/index.ts";
import { cx, defineTool, ok, r6, ri } from "./format.ts";
import { metricsJson } from "./convert.ts";
import {
  componentSchema,
  frequencySchema,
  languageSchema,
  loadSchema,
  q,
  resolveComponent,
  resolveLoad,
  resolveSweep,
  sweepSchema,
  z0Schema,
} from "./schemas.ts";

const lenStr = (cmp: { length: { kind: string; wavelengths?: number; meters?: number } }) =>
  cmp.length.kind === "electrical" ? `${r6(cmp.length.wavelengths as number)}λ` : formatSI(cmp.length.meters as number, "m");

export function describeComponent(cmp: Component): string {
  const p = "placement" in cmp ? `${cmp.placement} ` : "";
  switch (cmp.type) {
    case "inductor":
      return `${p}L ${formatSI(cmp.l, "H")}${cmp.q ? ` (Q=${cmp.q})` : ""}`;
    case "capacitor":
      return `${p}C ${formatSI(cmp.c, "F")}${cmp.q ? ` (Q=${cmp.q})` : ""}`;
    case "resistor":
      return `${p}R ${formatSI(cmp.r, "Ω")}`;
    case "rlc":
      return `${p}${cmp.arrangement} RLC (${[cmp.r !== undefined ? `R=${formatSI(cmp.r, "Ω")}` : "", cmp.l !== undefined ? `L=${formatSI(cmp.l, "H")}` : "", cmp.c !== undefined ? `C=${formatSI(cmp.c, "F")}` : ""].filter(Boolean).join(", ")})`;
    case "impedance":
      return `${p}Z ${cmp.z ? `${format(cmp.z)} Ω` : `table(${cmp.table?.length ?? 0})`}`;
    case "transmission_line":
      return `line Z0=${cmp.z0} Ω ℓ=${lenStr(cmp)}${cmp.eps_eff !== 1 ? ` εeff=${r6(cmp.eps_eff)}` : ""}`;
    case "stub":
      return `${cmp.placement} ${cmp.termination} stub Z0=${cmp.z0} Ω ℓ=${lenStr(cmp)}`;
    case "transformer":
      return `ideal transformer N=${cmp.turns_ratio}`;
    case "coupled_inductors":
      return `coupled inductors Lload=${formatSI(cmp.l_load, "H")} Lsource=${formatSI(cmp.l_source, "H")} k=${cmp.k}`;
  }
}

/** Shared by analyze_circuit and render_smith_chart. */
export const circuitInputShape = {
  load: loadSchema,
  components: z
    .array(componentSchema)
    .default([])
    .describe(
      "Circuit elements ordered from the LOAD towards the SOURCE (the first element is connected directly to the load). Empty = bare load.",
    ),
  frequency: frequencySchema.describe("Design / analysis frequency. Electrical lengths (λ, deg) are defined at this frequency."),
  z0: z0Schema,
};

export function registerCircuitTools(server: McpServer): void {
  defineTool(
    server,
    "analyze_circuit",
    {
      title: "Analyze a ladder / matching circuit",
      description: [
        "Analyze a cascaded RF circuit (load → components → source) the way a Smith chart does:",
        "returns the impedance, Γ and VSWR at every node, the final input impedance with return/mismatch loss,",
        "an optional frequency sweep (S11 in dB, VSWR vs. frequency), matched bandwidth for a VSWR limit,",
        "and Monte-Carlo-free tolerance corner analysis (± tolerance_pct on each component).",
        "Supported elements: inductor, capacitor, resistor (series or shunt, with Q/ESR/ESL), series/parallel RLC,",
        "custom impedance or Z(f) table, transmission line (lossy, εeff/velocity factor), open/short stubs (shunt or series),",
        "ideal transformer and coupled inductors. The load may be a constant Z, a Γ, a Z(f) table or a measured .s1p file (antenna).",
        "Use to verify a matching network, check an antenna tuner, or answer 'what impedance does the source see?'.",
      ].join(" "),
      inputSchema: {
        ...circuitInputShape,
        sweep: sweepSchema.optional(),
        bandwidth_vswr: z.number().gt(1).optional().describe("Report the contiguous bandwidth around frequency where VSWR ≤ this value (e.g. 2)."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const f0 = q(a.frequency, "frequency");
      const load = resolveLoad(a.load, a.z0);
      const comps = a.components.map((ci) => resolveComponent(ci, a.z0));
      const nodes = cascade(load.fn(f0), comps, f0, f0);
      const zin = nodes[nodes.length - 1];

      const stages = nodes.map((zn, i) => ({
        node: i,
        after: i === 0 ? "load" : (comps[i - 1].label ?? describeComponent(comps[i - 1])),
        z: cx(zn),
        gamma: cx(gammaFromZ(zn, a.z0)),
        vswr: r6(vswrOf(zn, a.z0)),
      }));

      const data: Record<string, unknown> = {
        frequency_hz: f0,
        z0: a.z0,
        load: { kind: load.describe, z_at_frequency: cx(load.fn(f0)) },
        components: comps.map((cmp, i) => ({ index: i + 1, description: describeComponent(cmp), ...(cmp.label ? { label: cmp.label } : {}) })),
        stages,
        input: metricsJson(zin, a.z0),
      };

      const vswrAt = (f: number) => vswrOf(inputImpedance(load.fn(f), comps, f, f0), a.z0);
      let bwLine = "";
      if (a.bandwidth_vswr) {
        const bw = matchedBandwidth(vswrAt, f0, a.bandwidth_vswr);
        data.bandwidth = bw;
        bwLine =
          bw.bandwidth_hz === null
            ? t(lang, `VSWR ≤ ${a.bandwidth_vswr} is not met at the design frequency.`, `Tasarım frekansında VSWR ≤ ${a.bandwidth_vswr} sağlanmıyor.`)
            : t(
                lang,
                `Bandwidth (VSWR ≤ ${a.bandwidth_vswr}): ${formatSI(bw.lower_hz as number, "Hz")} – ${formatSI(bw.upper_hz as number, "Hz")} = ${bw.limited ? "≥ " : ""}${formatSI(bw.bandwidth_hz, "Hz")} (${r6(bw.fractional_pct as number)} %)${bw.limited ? " — band extends beyond the search range" : ""}`,
                `Bant genişliği (VSWR ≤ ${a.bandwidth_vswr}): ${formatSI(bw.lower_hz as number, "Hz")} – ${formatSI(bw.upper_hz as number, "Hz")} = ${bw.limited ? "≥ " : ""}${formatSI(bw.bandwidth_hz, "Hz")} (% ${r6(bw.fractional_pct as number)})${bw.limited ? " — bant arama aralığının dışına taşıyor" : ""}`,
              );
      }

      let sweepLine = "";
      if (a.sweep) {
        const spec = resolveSweep(a.sweep, f0);
        const fs = sweepFrequencies(spec);
        const rows = fs.map((f) => {
          const zf = inputImpedance(load.fn(f), comps, f, f0);
          const g = abs(gammaFromZ(zf, a.z0));
          return { f_hz: r6(f), z: ri(zf), s11_db: r6(20 * Math.log10(g)), vswr: r6(vswrOf(zf, a.z0)) };
        });
        const best = rows.reduce((b, r) => (r.s11_db < b.s11_db ? r : b), rows[0]);
        // keep the payload small: at most ~201 rows
        const stride = Math.max(1, Math.ceil(rows.length / 201));
        data.sweep = {
          start_hz: spec.start,
          stop_hz: spec.stop,
          points: rows.length,
          best_match: best,
          rows: rows.filter((_, i) => i % stride === 0 || i === rows.length - 1),
          ...(stride > 1 ? { note: `rows decimated by ${stride} for brevity` } : {}),
        };
        sweepLine = t(
          lang,
          `Best match in sweep: ${formatSI(best.f_hz, "Hz")} (S11 = ${best.s11_db} dB, VSWR = ${best.vswr})`,
          `Taramadaki en iyi eşleşme: ${formatSI(best.f_hz, "Hz")} (S11 = ${best.s11_db} dB, VSWR = ${best.vswr})`,
        );
      }

      let tolLine = "";
      const corners = toleranceCorners(comps);
      if (corners.length > 0) {
        let worst = { vswr: -1, factors: corners[0], z: zin };
        let bestC = { vswr: Number.POSITIVE_INFINITY, factors: corners[0], z: zin };
        for (const fct of corners) {
          const zc = inputImpedance(load.fn(f0), comps, f0, f0, fct);
          const v = vswrOf(zc, a.z0);
          if (v > worst.vswr) worst = { vswr: v, factors: fct, z: zc };
          if (v < bestC.vswr) bestC = { vswr: v, factors: fct, z: zc };
        }
        data.tolerance = {
          corners_evaluated: corners.length,
          vswr_min: r6(bestC.vswr),
          vswr_max: r6(worst.vswr),
          worst_case: { z_in: cx(worst.z), multipliers: worst.factors.map(r6) },
        };
        tolLine = t(
          lang,
          `Tolerance corners (${corners.length}): VSWR ${r6(bestC.vswr)} … ${r6(worst.vswr)}`,
          `Tolerans köşeleri (${corners.length}): VSWR ${r6(bestC.vswr)} … ${r6(worst.vswr)}`,
        );
      }

      const m = metricsJson(zin, a.z0);
      const summary = [
        t(
          lang,
          `At ${formatSI(f0, "Hz")}: Zin = ${format(zin)} Ω  →  Γ = ${m.gamma.mag} ∠ ${m.gamma.angle_deg}°, VSWR = ${m.vswr}, RL = ${m.return_loss_db} dB`,
          `${formatSI(f0, "Hz")} frekansında: Zin = ${format(zin)} Ω  →  Γ = ${m.gamma.mag} ∠ ${m.gamma.angle_deg}°, VSWR = ${m.vswr}, geri dönüş kaybı = ${m.return_loss_db} dB`,
        ),
        t(lang, `Load: ${format(load.fn(f0))} Ω, ${comps.length} component(s).`, `Yük: ${format(load.fn(f0))} Ω, ${comps.length} bileşen.`),
        bwLine,
        sweepLine,
        tolLine,
      ].filter(Boolean);
      return ok(summary.join("\n"), data);
    },
  );
}
