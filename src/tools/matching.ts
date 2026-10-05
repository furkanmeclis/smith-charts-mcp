import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Component } from "../core/circuit.ts";
import { abs, type Complex, c, conj, format } from "../core/complex.ts";
import {
  dcBehaviour,
  type ESeries,
  lMatchRaw,
  piTMatchRaw,
  quarterWaveOptions,
  rawToComponents,
  responseType,
  singleStubRaw,
  snapComponents,
  verify,
} from "../core/matching.ts";
import { gammaFromZ } from "../core/rf.ts";
import { formatSI, SPEED_OF_LIGHT } from "../core/units.ts";
import { type Lang, resolveLang, t } from "../i18n/index.ts";
import { describeComponent } from "./circuit.ts";
import { cx, defineTool, ok, r6 } from "./format.ts";
import {
  complexSchema,
  frequencySchema,
  InputError,
  languageSchema,
  loadSchema,
  parseComplex,
  q,
  resolveLoad,
  z0Schema,
} from "./schemas.ts";

/** Serialises a resolved component back into the tool input format (so results can be chained). */
export function toComponentInput(cmp: Component): Record<string, unknown> {
  const s = (v: number, u: string) => formatSI(v, u, 5).replace(" ", "");
  const lenOut = (len: Component & { length: unknown }) => {
    const l = (len as { length: { kind: string; wavelengths?: number; meters?: number } }).length;
    return l.kind === "electrical" ? `${r6(l.wavelengths as number)}λ` : s(l.meters as number, "m");
  };
  switch (cmp.type) {
    case "inductor":
      return { type: "inductor", placement: cmp.placement, value: s(cmp.l, "H") };
    case "capacitor":
      return { type: "capacitor", placement: cmp.placement, value: s(cmp.c, "F") };
    case "resistor":
      return { type: "resistor", placement: cmp.placement, value: s(cmp.r, "Ω") };
    case "transmission_line":
      return { type: "transmission_line", z0: r6(cmp.z0), length: lenOut(cmp), ...(cmp.eps_eff !== 1 ? { eps_eff: r6(cmp.eps_eff) } : {}) };
    case "stub":
      return {
        type: "stub",
        termination: cmp.termination,
        placement: cmp.placement,
        z0: r6(cmp.z0),
        length: lenOut(cmp),
        ...(cmp.eps_eff !== 1 ? { eps_eff: r6(cmp.eps_eff) } : {}),
      };
    default:
      return { ...cmp };
  }
}

const sharedShape = {
  load: loadSchema,
  source: complexSchema
    .optional()
    .describe("Source impedance (default = z0, purely resistive). Complex sources are conjugately matched."),
  z0: z0Schema,
  bandwidth_vswr: z
    .number()
    .gt(1)
    .default(2)
    .describe("VSWR limit used to report the matched bandwidth of each solution (default 2 ≈ 9.5 dB return loss)."),
  language: languageSchema,
};

const snapSchema = z
  .enum(["E6", "E12", "E24", "E48", "E96"])
  .optional()
  .describe("Also round L/C values to this standard E-series and report the resulting match.");

function verificationJson(v: ReturnType<typeof verify>, f0?: number) {
  return {
    z_in: cx(v.z_in),
    vswr: r6(v.vswr),
    return_loss_db: r6(v.return_loss_db),
    ...(v.bandwidth
      ? {
          bandwidth: f0
            ? v.bandwidth
            : { threshold_vswr: v.bandwidth.threshold_vswr, fractional_pct: v.bandwidth.fractional_pct, limited: v.bandwidth.limited },
        }
      : {}),
  };
}

function bwText(lang: Lang, v: ReturnType<typeof verify>, absolute: boolean): string {
  const b = v.bandwidth;
  if (!b || b.fractional_pct === null) return "";
  const ge = b.limited ? "≥ " : ""; // search hit its limit: the band is at least this wide
  const frac = `${ge}${r6(b.fractional_pct)} %`;
  return absolute && b.bandwidth_hz !== null
    ? t(lang, `BW ${ge}${formatSI(b.bandwidth_hz, "Hz")} (${frac})`, `BG ${ge}${formatSI(b.bandwidth_hz, "Hz")} (${frac})`)
    : t(lang, `BW ${frac}`, `BG ${frac}`);
}

function lumpedSolution(
  lang: Lang,
  id: number,
  topology: string,
  comps: Component[],
  load: (f: number) => Complex,
  zs: Complex,
  f0: number,
  bwVswr: number,
  snap: ESeries | undefined,
  extra: Record<string, unknown> = {},
) {
  const v = verify(load, comps, zs, f0, bwVswr);
  const sol: Record<string, unknown> = {
    id,
    topology,
    description: comps.map(describeComponent).join(" → ") || "none",
    response: responseType(comps),
    ...dcBehaviour(comps),
    ...extra,
    components: comps.map(toComponentInput),
    verification: verificationJson(v, f0),
  };
  let snapped = "";
  if (snap) {
    const sc = snapComponents(comps, snap);
    const sv = verify(load, sc, zs, f0, bwVswr);
    sol.snapped = { series: snap, components: sc.map(toComponentInput), verification: verificationJson(sv, f0) };
    snapped = t(lang, ` | ${snap}: VSWR ${r6(sv.vswr)}`, ` | ${snap}: VSWR ${r6(sv.vswr)}`);
  }
  const line = `#${id} ${topology}: ${sol.description} — VSWR ${r6(v.vswr)}, ${bwText(lang, v, true)}${snapped}`;
  return { sol, line, bw: v.bandwidth?.bandwidth_hz ?? 0 };
}

type Preference = "widest_bandwidth" | "lowpass" | "highpass" | "dc_block" | "dc_feed";

function sortByPreference<T extends { sol: Record<string, unknown>; bw: number }>(arr: T[], pref?: Preference): T[] {
  const score = (x: T) => {
    const s = x.sol;
    if (pref === "lowpass") return s.response === "lowpass" ? 1 : 0;
    if (pref === "highpass") return s.response === "highpass" ? 1 : 0;
    if (pref === "dc_block") return s.dc_block ? 1 : 0;
    if (pref === "dc_feed") return !s.dc_block ? 1 : 0;
    return 0;
  };
  return [...arr].sort((a, b) => score(b) - score(a) || b.bw - a.bw);
}

const preferenceSchema = z
  .enum(["widest_bandwidth", "lowpass", "highpass", "dc_block", "dc_feed"])
  .optional()
  .describe("Order solutions by this preference (ties broken by bandwidth). Default: widest bandwidth first.");

export function registerMatchingTools(server: McpServer): void {
  defineTool(
    server,
    "design_l_match",
    {
      title: "Design L-section matching networks",
      description: [
        "Synthesize every two-element lumped L-network (series/shunt L and C) that matches a load to a source at one frequency.",
        "Handles complex loads and complex sources (conjugate match). Returns 2–4 solutions with exact component values,",
        "low-pass/high-pass classification, DC-block/DC-feed behaviour, verified input impedance and VSWR, matched bandwidth,",
        "and optional rounding to standard E12/E24/E96 values. Elements are listed load → source and can be passed directly",
        "to analyze_circuit or render_smith_chart. Use for 'match 25-j15 Ω to 50 Ω at 2.4 GHz'.",
      ].join(" "),
      inputSchema: {
        ...sharedShape,
        frequency: frequencySchema,
        snap_to_series: snapSchema,
        preference: preferenceSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const f0 = q(a.frequency, "frequency");
      const load = resolveLoad(a.load, a.z0);
      const zl = load.fn(f0);
      const zs = a.source !== undefined ? parseComplex(a.source) : c(a.z0);
      const raws = lMatchRaw(zl, conj(zs));
      if (raws.length === 0)
        throw new InputError("No L-network solution: the load must have a positive real part (a purely reactive load cannot be matched losslessly).");
      // different topologies can collapse to the same network when one element vanishes (e.g. a single shunt C)
      const seen = new Set<string>();
      const candidates = raws
        .map((r) => ({ r, comps: rawToComponents(r.elements, f0, Math.max(a.z0, abs(zl))) }))
        .filter(({ comps }) => {
          const key = comps.map(describeComponent).join("|");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      const sols = sortByPreference(
        candidates.map(({ r, comps }, i) =>
          lumpedSolution(
            lang,
            i + 1,
            comps.length < 2
              ? comps.length === 0
                ? "already matched"
                : "single element"
              : r.topology === "shunt_series"
                ? "shunt-at-load, series-to-source"
                : "series-at-load, shunt-to-source",
            comps,
            load.fn,
            zs,
            f0,
            a.bandwidth_vswr,
            a.snap_to_series as ESeries | undefined,
          ),
        ),
        a.preference as Preference | undefined,
      ).map((s, i) => ({ ...s, sol: { ...s.sol, id: i + 1 }, line: s.line.replace(/^#\d+/, `#${i + 1}`) }));
      const summary = [
        t(
          lang,
          `L-match ${format(zl)} Ω → ${format(zs)} Ω at ${formatSI(f0, "Hz")}: ${sols.length} solution(s) (elements listed load → source)`,
          `${formatSI(f0, "Hz")} frekansında L-eşleştirme ${format(zl)} Ω → ${format(zs)} Ω: ${sols.length} çözüm (elemanlar yükten kaynağa sıralı)`,
        ),
        ...sols.map((s) => s.line),
      ];
      return ok(summary.join("\n"), {
        frequency_hz: f0,
        z0: a.z0,
        load: cx(zl),
        source: cx(zs),
        solutions: sols.map((s) => s.sol),
      });
    },
  );

  defineTool(
    server,
    "design_pi_t_match",
    {
      title: "Design Pi / T matching networks with a target Q",
      description: [
        "Synthesize three-element Pi (shunt-series-shunt) or T (series-shunt-series) lumped matching networks for a chosen",
        "loaded Q, giving control over bandwidth/harmonic suppression that an L-network cannot. Q must exceed √(Rhigh/Rlow − 1).",
        "Returns all low-pass/high-pass/mixed variants with component values, virtual resistance, verification and bandwidth.",
        "Use for PA output networks, harmonic filtering, or 'match 10 Ω to 50 Ω with Q = 5'.",
      ].join(" "),
      inputSchema: {
        ...sharedShape,
        frequency: frequencySchema,
        q: z.number().positive().describe("Desired loaded Q of the network (sets bandwidth ≈ f0/Q)."),
        topology: z.enum(["pi", "t", "both"]).default("both").describe("Network type."),
        snap_to_series: snapSchema,
        preference: preferenceSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const f0 = q(a.frequency, "frequency");
      const load = resolveLoad(a.load, a.z0);
      const zl = load.fn(f0);
      const zs = a.source !== undefined ? parseComplex(a.source) : c(a.z0);
      const kinds = a.topology === "both" ? (["pi", "t"] as const) : ([a.topology] as const);
      const all: ReturnType<typeof lumpedSolution>[] = [];
      const errors: string[] = [];
      for (const kind of kinds) {
        const res = piTMatchRaw(zl, zs, a.q, kind);
        if (!Array.isArray(res)) {
          errors.push(`${kind.toUpperCase()}: ${res.error}`);
          continue;
        }
        for (const r of res)
          all.push(
            lumpedSolution(lang, all.length + 1, kind.toUpperCase(), rawToComponents(r.elements, f0, Math.max(a.z0, abs(zl))), load.fn, zs, f0, a.bandwidth_vswr, a.snap_to_series as ESeries | undefined, {
              virtual_resistance_ohm: r6(r.virtual_resistance),
            }),
          );
      }
      if (all.length === 0) throw new InputError(errors.join("; "));
      const sols = sortByPreference(all, a.preference as Preference | undefined).map((s, i) => ({
        ...s,
        sol: { ...s.sol, id: i + 1 },
        line: s.line.replace(/^#\d+/, `#${i + 1}`),
      }));
      const summary = [
        t(
          lang,
          `${a.topology === "both" ? "Pi/T" : a.topology.toUpperCase()} match ${format(zl)} Ω → ${format(zs)} Ω, Q = ${a.q}, f = ${formatSI(f0, "Hz")}: ${sols.length} solution(s)`,
          `${a.topology === "both" ? "Pi/T" : a.topology.toUpperCase()} eşleştirme ${format(zl)} Ω → ${format(zs)} Ω, Q = ${a.q}, f = ${formatSI(f0, "Hz")}: ${sols.length} çözüm`,
        ),
        ...errors,
        ...sols.map((s) => s.line),
      ];
      return ok(summary.join("\n"), {
        frequency_hz: f0,
        q: a.q,
        load: cx(zl),
        source: cx(zs),
        ...(errors.length ? { infeasible: errors } : {}),
        solutions: sols.map((s) => s.sol),
      });
    },
  );

  defineTool(
    server,
    "design_stub_match",
    {
      title: "Design single-stub matching (distributed)",
      description: [
        "Single-stub tuner design (Pozar §5.2): find the distance d from the load along the main line and the length ℓ of an",
        "open- or short-circuited stub (shunt or series) that matches the load to Z0. Returns all solutions in wavelengths,",
        "degrees and — when frequency is given — physical length (with eps_eff / velocity_factor), plus verification and",
        "matched bandwidth. Components are returned load → source for analyze_circuit / render_smith_chart.",
        "Use for microstrip/coax stub tuners and textbook Smith chart stub problems.",
      ].join(" "),
      inputSchema: {
        ...sharedShape,
        frequency: frequencySchema.optional().describe("Optional: needed for physical lengths and frequency-dependent loads."),
        stub_z0: z.number().positive().optional().describe("Characteristic impedance of the stub (default = z0)."),
        termination: z.enum(["open", "short", "both"]).default("both").describe("Stub termination to report."),
        placement: z.enum(["shunt", "series"]).default("shunt").describe("Shunt (parallel) or series stub."),
        eps_eff: z.number().min(1).optional().describe("Effective permittivity of the lines (default 1)."),
        velocity_factor: z.number().gt(0).max(1).optional().describe("Velocity factor; overrides eps_eff."),
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      if (a.source !== undefined) throw new InputError("design_stub_match matches to the real line impedance z0; omit 'source'.");
      const load = resolveLoad(a.load, a.z0);
      if (!load.describe.startsWith("constant") && a.frequency === undefined)
        throw new InputError("frequency is required for frequency-dependent loads");
      const hasF = a.frequency !== undefined;
      const f0 = hasF ? q(a.frequency as never, "frequency") : 1e9;
      const zl = load.fn(f0);
      const stubZ0 = a.stub_z0 ?? a.z0;
      const eps = a.velocity_factor ? 1 / a.velocity_factor ** 2 : (a.eps_eff ?? 1);
      const lambdaG = SPEED_OF_LIGHT / (f0 * Math.sqrt(eps));
      const raws = singleStubRaw(zl, a.z0, stubZ0, a.placement).filter(
        (s) => a.termination === "both" || s.termination === a.termination,
      );
      if (raws.length === 0) throw new InputError("No stub solution: the load must have a positive real part.");
      const sols = raws.map((s, i) => {
        const comps: Component[] = [
          { type: "transmission_line", z0: a.z0, length: { kind: "electrical", wavelengths: s.distance_wavelengths }, eps_eff: eps, loss_db_per_m: 0 },
          {
            type: "stub",
            termination: s.termination,
            placement: s.placement,
            z0: stubZ0,
            length: { kind: "electrical", wavelengths: s.stub_length_wavelengths },
            eps_eff: eps,
            loss_db_per_m: 0,
          },
        ];
        const v = verify(load.fn, comps, c(a.z0), f0, a.bandwidth_vswr);
        const sol = {
          id: i + 1,
          termination: s.termination,
          placement: s.placement,
          distance_from_load: {
            wavelengths: r6(s.distance_wavelengths),
            degrees: r6(s.distance_wavelengths * 360),
            ...(hasF ? { meters: r6(s.distance_wavelengths * lambdaG) } : {}),
          },
          stub_length: {
            wavelengths: r6(s.stub_length_wavelengths),
            degrees: r6(s.stub_length_wavelengths * 360),
            ...(hasF ? { meters: r6(s.stub_length_wavelengths * lambdaG) } : {}),
          },
          components: comps.map(toComponentInput),
          verification: verificationJson(v, hasF ? f0 : undefined),
        };
        const line = t(
          lang,
          `#${i + 1} ${s.termination} ${s.placement} stub: d = ${r6(s.distance_wavelengths)} λ, ℓ = ${r6(s.stub_length_wavelengths)} λ${hasF ? ` (d = ${formatSI(s.distance_wavelengths * lambdaG, "m")}, ℓ = ${formatSI(s.stub_length_wavelengths * lambdaG, "m")})` : ""} — VSWR ${r6(v.vswr)}, ${bwText(lang, v, hasF)}`,
          `#${i + 1} ${s.termination === "open" ? "açık uçlu" : "kısa devre"} ${s.placement === "shunt" ? "paralel" : "seri"} stub: d = ${r6(s.distance_wavelengths)} λ, ℓ = ${r6(s.stub_length_wavelengths)} λ${hasF ? ` (d = ${formatSI(s.distance_wavelengths * lambdaG, "m")}, ℓ = ${formatSI(s.stub_length_wavelengths * lambdaG, "m")})` : ""} — VSWR ${r6(v.vswr)}, ${bwText(lang, v, hasF)}`,
        );
        return { sol, line };
      });
      return ok(
        [
          t(lang, `Single-stub match of ${format(zl)} Ω to ${a.z0} Ω (stub Z0 = ${stubZ0} Ω):`, `${format(zl)} Ω yükün ${a.z0} Ω hatta tek stub ile eşleştirilmesi (stub Z0 = ${stubZ0} Ω):`),
          ...sols.map((s) => s.line),
          hasF ? "" : t(lang, "(No frequency given: bandwidth is fractional only.)", "(Frekans verilmedi: bant genişliği yalnızca oransal.)"),
        ]
          .filter(Boolean)
          .join("\n"),
        {
          z0: a.z0,
          stub_z0: stubZ0,
          eps_eff: r6(eps),
          ...(hasF ? { frequency_hz: f0, guided_wavelength_m: r6(lambdaG) } : {}),
          load: cx(zl),
          load_gamma: cx(gammaFromZ(zl, a.z0)),
          solutions: sols.map((s) => s.sol),
        },
      );
    },
  );

  defineTool(
    server,
    "design_quarter_wave",
    {
      title: "Design a quarter-wave (λ/4) transformer",
      description: [
        "Design a λ/4 impedance transformer Z1 = √(Z0·R). Real loads are matched directly; complex loads first get a",
        "section of Z0 line that rotates them to the nearest voltage maximum (R = Z0·VSWR) or minimum (R = Z0/VSWR) on",
        "the real axis. Returns the offset length, transformer impedance, physical lengths (if frequency is given),",
        "verification and matched bandwidth. Elements are listed load → source.",
      ].join(" "),
      inputSchema: {
        ...sharedShape,
        frequency: frequencySchema.optional().describe("Optional: needed for physical lengths and frequency-dependent loads."),
        eps_eff: z.number().min(1).optional().describe("Effective permittivity of the lines (default 1)."),
        velocity_factor: z.number().gt(0).max(1).optional().describe("Velocity factor; overrides eps_eff."),
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      if (a.source !== undefined) throw new InputError("design_quarter_wave matches to the real line impedance z0; omit 'source'.");
      const load = resolveLoad(a.load, a.z0);
      if (!load.describe.startsWith("constant") && a.frequency === undefined)
        throw new InputError("frequency is required for frequency-dependent loads");
      const hasF = a.frequency !== undefined;
      const f0 = hasF ? q(a.frequency as never, "frequency") : 1e9;
      const zl = load.fn(f0);
      const eps = a.velocity_factor ? 1 / a.velocity_factor ** 2 : (a.eps_eff ?? 1);
      const lambdaG = SPEED_OF_LIGHT / (f0 * Math.sqrt(eps));
      const opts = quarterWaveOptions(zl, a.z0);
      if (opts.length === 0) throw new InputError("Load cannot be matched (|Γ| = 1, purely reactive load).");
      const sols = opts.map((o, i) => {
        const comps: Component[] = [];
        if (o.offset_wavelengths > 1e-12)
          comps.push({ type: "transmission_line", z0: a.z0, length: { kind: "electrical", wavelengths: o.offset_wavelengths }, eps_eff: eps, loss_db_per_m: 0 });
        comps.push({ type: "transmission_line", z0: o.transformer_z0, length: { kind: "electrical", wavelengths: 0.25 }, eps_eff: eps, loss_db_per_m: 0 });
        const v = verify(load.fn, comps, c(a.z0), f0, a.bandwidth_vswr);
        return {
          sol: {
            id: i + 1,
            rotation_point: o.point,
            offset_line: {
              z0: a.z0,
              wavelengths: r6(o.offset_wavelengths),
              degrees: r6(o.offset_wavelengths * 360),
              ...(hasF ? { meters: r6(o.offset_wavelengths * lambdaG) } : {}),
            },
            r_at_transformer_ohm: r6(o.r_at_transformer),
            transformer: { z0: r6(o.transformer_z0), wavelengths: 0.25, ...(hasF ? { meters: r6(0.25 * lambdaG) } : {}) },
            components: comps.map(toComponentInput),
            verification: verificationJson(v, hasF ? f0 : undefined),
          },
          line: t(
            lang,
            `#${i + 1} (${o.point.replace(/_/g, " ")}): ${o.offset_wavelengths > 1e-12 ? `${r6(o.offset_wavelengths)} λ of ${a.z0} Ω line, then ` : ""}λ/4 of Z1 = ${r6(o.transformer_z0)} Ω — VSWR ${r6(v.vswr)}, ${bwText(lang, v, hasF)}`,
            `#${i + 1} (${o.point === "voltage_maximum" ? "gerilim maksimumu" : o.point === "voltage_minimum" ? "gerilim minimumu" : "yük zaten reel"}): ${o.offset_wavelengths > 1e-12 ? `${r6(o.offset_wavelengths)} λ uzunluğunda ${a.z0} Ω hat, ardından ` : ""}Z1 = ${r6(o.transformer_z0)} Ω λ/4 trafo — VSWR ${r6(v.vswr)}, ${bwText(lang, v, hasF)}`,
          ),
        };
      });
      return ok(
        [t(lang, `Quarter-wave match of ${format(zl)} Ω to ${a.z0} Ω:`, `${format(zl)} Ω yükün ${a.z0} Ω hatta λ/4 trafo ile eşleştirilmesi:`), ...sols.map((s) => s.line)].join("\n"),
        {
          z0: a.z0,
          eps_eff: r6(eps),
          ...(hasF ? { frequency_hz: f0, guided_wavelength_m: r6(lambdaG) } : {}),
          load: cx(zl),
          solutions: sols.map((s) => s.sol),
        },
      );
    },
  );
}

