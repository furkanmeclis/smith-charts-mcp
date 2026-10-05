import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { abs, type Complex, c, format, formatPolar } from "../core/complex.ts";
import { lMatchRaw, rawToComponents, responseType } from "../core/matching.ts";
import { dB20, gammaFromZ, vswrFromGammaMag, zFromGamma } from "../core/rf.ts";
import {
  availableGain,
  conjugateMatch,
  gainCircle,
  type GainCircleType,
  interpolateNoise,
  type NoiseParams,
  noiseCircle,
  noiseFigureAt,
  stability,
  type Touchstone,
  type TwoPort,
  unilateralMaxDb,
} from "../core/sparams.ts";
import { formatSI } from "../core/units.ts";
import { type Lang, resolveLang, t } from "../i18n/index.ts";
import { describeComponent } from "./circuit.ts";
import { cx, defineTool, ok, r6, ri } from "./format.ts";
import { toComponentInput } from "./matching.ts";
import {
  complexSchema,
  deviceSchema,
  frequencySchema,
  gammaSchema,
  InputError,
  languageSchema,
  loadTouchstone,
  parseComplex,
  parseGamma,
  q,
  resolveDevice,
  touchstoneSourceSchema,
} from "./schemas.ts";

const db = (x: number) => r6(10 * Math.log10(x));

function stabilityJson(s: TwoPort, z0: number) {
  const st = stability(s);
  const circ = (ci: typeof st.load_circle) => ({
    center_gamma: cx(ci.center),
    radius: r6(ci.radius),
    stable_region: ci.stable_region,
    center_z: cx(zFromGamma(ci.center, z0)),
  });
  return {
    k: r6(st.k),
    delta: cx(st.delta),
    delta_magnitude: r6(st.delta_magnitude),
    mu_load: r6(st.mu_load),
    mu_source: r6(st.mu_source),
    unconditionally_stable: st.unconditionally_stable,
    load_plane_circle: circ(st.load_circle),
    source_plane_circle: circ(st.source_circle),
  };
}

function clampNote(lang: Lang, clamped: boolean) {
  return clamped
    ? t(lang, "⚠ Requested frequency is outside the Touchstone data range; the nearest data point was used.", "⚠ İstenen frekans Touchstone veri aralığının dışında; en yakın veri noktası kullanıldı.")
    : "";
}

function contiguousRanges(fs: number[], flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  flags.forEach((fl, i) => {
    if (fl && start === null) start = fs[i];
    if ((!fl || i === flags.length - 1) && start !== null) {
      out.push([start, fl ? fs[i] : fs[i - 1]]);
      start = null;
    }
  });
  return out;
}

const pointToTwoPort = (p: Touchstone["points"][number]): TwoPort => ({
  s11: p.s11,
  s21: p.s21 ?? c(0),
  s12: p.s12 ?? c(0),
  s22: p.s22 ?? c(0),
});

export function registerAmplifierTools(server: McpServer): void {
  defineTool(
    server,
    "parse_touchstone",
    {
      title: "Parse & summarize a Touchstone (.s1p / .s2p) file",
      description: [
        "Read a Touchstone v1 S-parameter file (from a VNA, simulator or datasheet) and summarize it: port count,",
        "reference impedance, frequency range, per-frequency table (S11/S21/S12/S22 in dB and angle, VSWR, input impedance,",
        "and for 2-ports K, μ and MAG/MSG), resonance / best match for 1-ports, unconditionally stable ranges for 2-ports,",
        "and noise parameters if present. Supports MA/DB/RI formats and any frequency unit.",
      ].join(" "),
      inputSchema: {
        ...touchstoneSourceSchema,
        max_rows: z.number().int().min(1).max(1000).default(40).describe("Maximum table rows to return (data is decimated evenly)."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const ts = loadTouchstone(a);
      if (ts.points.length === 0) throw new InputError("No data points in file");
      const stride = Math.max(1, Math.ceil(ts.points.length / a.max_rows));
      const pick = <T>(arr: T[]) => arr.filter((_, i) => i % stride === 0 || i === arr.length - 1);
      const fs = ts.points.map((p) => p.frequency);
      const data: Record<string, unknown> = {
        ports: ts.ports,
        z0: ts.z0,
        format: ts.format,
        frequency_unit: ts.frequency_unit,
        points: ts.points.length,
        start_hz: fs[0],
        stop_hz: fs[fs.length - 1],
        has_noise_parameters: ts.noise.length > 0,
        ...(ts.warnings.length ? { warnings: ts.warnings } : {}),
      };
      const lines: string[] = [
        t(
          lang,
          `${ts.ports}-port Touchstone, Z0 = ${ts.z0} Ω, ${ts.points.length} points from ${formatSI(fs[0], "Hz")} to ${formatSI(fs[fs.length - 1], "Hz")}${ts.noise.length ? `, ${ts.noise.length} noise points` : ""}.`,
          `${ts.ports} portlu Touchstone, Z0 = ${ts.z0} Ω, ${formatSI(fs[0], "Hz")} – ${formatSI(fs[fs.length - 1], "Hz")} arası ${ts.points.length} nokta${ts.noise.length ? `, ${ts.noise.length} gürültü noktası` : ""}.`,
        ),
      ];
      if (ts.ports === 1) {
        const rows = ts.points.map((p) => {
          const g = abs(p.s11);
          return { f_hz: p.frequency, s11_db: r6(dB20(g)), s11_angle_deg: r6((Math.atan2(p.s11.im, p.s11.re) * 180) / Math.PI), vswr: r6(vswrFromGammaMag(g)), z: ri(zFromGamma(p.s11, ts.z0)) };
        });
        const best = rows.reduce((b, r) => (r.s11_db < b.s11_db ? r : b), rows[0]);
        data.best_match = best;
        data.rows = pick(rows);
        lines.push(
          t(
            lang,
            `Best match at ${formatSI(best.f_hz, "Hz")}: S11 = ${best.s11_db} dB, VSWR = ${best.vswr}, Z = ${format(c(best.z.re, best.z.im))} Ω.`,
            `En iyi eşleşme ${formatSI(best.f_hz, "Hz")}: S11 = ${best.s11_db} dB, VSWR = ${best.vswr}, Z = ${format(c(best.z.re, best.z.im))} Ω.`,
          ),
        );
      } else {
        const rows = ts.points.map((p) => {
          const s = pointToTwoPort(p);
          const st = stability(s);
          const msg = abs(s.s21) / abs(s.s12);
          const mag = st.k > 1 ? msg * (st.k - Math.sqrt(st.k ** 2 - 1)) : msg;
          return {
            f_hz: p.frequency,
            s11_db: r6(dB20(abs(s.s11))),
            s21_db: r6(dB20(abs(s.s21))),
            s12_db: r6(dB20(abs(s.s12))),
            s22_db: r6(dB20(abs(s.s22))),
            k: r6(st.k),
            mu: r6(st.mu_load),
            unconditionally_stable: st.unconditionally_stable,
            [st.k > 1 ? "mag_db" : "msg_db"]: db(mag),
          };
        });
        const stableRanges = contiguousRanges(fs, rows.map((r) => r.unconditionally_stable));
        data.unconditionally_stable_ranges_hz = stableRanges;
        data.rows = pick(rows);
        if (ts.noise.length)
          data.noise = pick(ts.noise).map((n) => ({ f_hz: n.frequency, nf_min_db: n.nf_min_db, gamma_opt: cx(n.gamma_opt), rn_ohm: r6(n.rn) }));
        lines.push(
          stableRanges.length
            ? t(
                lang,
                `Unconditionally stable: ${stableRanges.map(([x, y]) => `${formatSI(x, "Hz")}–${formatSI(y, "Hz")}`).join(", ")}.`,
                `Koşulsuz kararlı aralık: ${stableRanges.map(([x, y]) => `${formatSI(x, "Hz")}–${formatSI(y, "Hz")}`).join(", ")}.`,
              )
            : t(lang, "Potentially unstable at every frequency in the file.", "Dosyadaki tüm frekanslarda potansiyel olarak kararsız."),
        );
      }
      if (stride > 1) data.note = `rows decimated by ${stride}`;
      return ok(lines.join("\n"), data);
    },
  );

  defineTool(
    server,
    "amplifier_stability",
    {
      title: "Two-port (amplifier) stability analysis",
      description: [
        "Rollett stability factor K, |Δ|, Edwards-Sinsky μ (load) and μ' (source), unconditional-stability verdict and the",
        "input (source-plane) and output (load-plane) stability circles with their stable side. With a Touchstone file and",
        "no frequency, returns a K/μ table over the whole file and the stable frequency ranges.",
        "Use before designing any amplifier matching network to know which source/load impedances are safe.",
      ].join(" "),
      inputSchema: {
        device: deviceSchema,
        frequency: frequencySchema.optional().describe("Analysis frequency (interpolated). Omit with a Touchstone file to sweep the whole file."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      if (a.frequency === undefined && (a.device.touchstone_path || a.device.touchstone_content)) {
        const ts = loadTouchstone(a.device);
        if (ts.ports !== 2) throw new InputError("A 2-port (.s2p) file is required");
        const rows = ts.points.map((p) => {
          const st = stability(pointToTwoPort(p));
          return { f_hz: p.frequency, k: r6(st.k), delta_magnitude: r6(st.delta_magnitude), mu_load: r6(st.mu_load), mu_source: r6(st.mu_source), unconditionally_stable: st.unconditionally_stable };
        });
        const ranges = contiguousRanges(rows.map((r) => r.f_hz), rows.map((r) => r.unconditionally_stable));
        return ok(
          ranges.length
            ? t(lang, `Unconditionally stable ranges: ${ranges.map(([x, y]) => `${formatSI(x, "Hz")}–${formatSI(y, "Hz")}`).join(", ")}. Elsewhere potentially unstable.`, `Koşulsuz kararlı aralıklar: ${ranges.map(([x, y]) => `${formatSI(x, "Hz")}–${formatSI(y, "Hz")}`).join(", ")}. Diğer frekanslarda potansiyel kararsız.`)
            : t(lang, "Potentially unstable over the whole file — check the stability circles at your design frequency.", "Dosyanın tamamında potansiyel kararsız — tasarım frekansındaki kararlılık çemberlerini inceleyin."),
          { z0: ts.z0, unconditionally_stable_ranges_hz: ranges, rows },
        );
      }
      const dev = resolveDevice(a.device, a.frequency);
      const sj = stabilityJson(dev.s, dev.z0);
      const verdict = sj.unconditionally_stable
        ? t(lang, "UNCONDITIONALLY STABLE (μ > 1): any passive source/load is safe.", "KOŞULSUZ KARARLI (μ > 1): her pasif kaynak/yük güvenli.")
        : t(
            lang,
            "POTENTIALLY UNSTABLE: keep ΓS and ΓL in the stable regions of the stability circles (or add resistive loading / feedback).",
            "POTANSİYEL KARARSIZ: ΓS ve ΓL kararlılık çemberlerinin kararlı bölgesinde kalmalı (veya dirençli yükleme/geri besleme ekleyin).",
          );
      const summary = [
        dev.f ? `f = ${formatSI(dev.f, "Hz")}` : "",
        `K = ${sj.k}, |Δ| = ${sj.delta_magnitude}, μ = ${sj.mu_load}, μ' = ${sj.mu_source}`,
        verdict,
        t(
          lang,
          `Load-plane circle: C = ${formatPolar(stability(dev.s).load_circle.center)}, r = ${sj.load_plane_circle.radius}, stable ${sj.load_plane_circle.stable_region}.`,
          `Yük düzlemi çemberi: C = ${formatPolar(stability(dev.s).load_circle.center)}, r = ${sj.load_plane_circle.radius}, kararlı bölge ${sj.load_plane_circle.stable_region === "inside" ? "içeride" : "dışarıda"}.`,
        ),
        t(
          lang,
          `Source-plane circle: C = ${formatPolar(stability(dev.s).source_circle.center)}, r = ${sj.source_plane_circle.radius}, stable ${sj.source_plane_circle.stable_region}.`,
          `Kaynak düzlemi çemberi: C = ${formatPolar(stability(dev.s).source_circle.center)}, r = ${sj.source_plane_circle.radius}, kararlı bölge ${sj.source_plane_circle.stable_region === "inside" ? "içeride" : "dışarıda"}.`,
        ),
        clampNote(lang, dev.clamped),
      ].filter(Boolean);
      return ok(summary.join("\n"), { ...(dev.f ? { frequency_hz: dev.f } : {}), z0: dev.z0, ...sj });
    },
  );

  defineTool(
    server,
    "gain_circles",
    {
      title: "Constant-gain circles",
      description: [
        "Constant-gain circles for amplifier design (Pozar ch. 12): 'available' (G_A, source plane, bilateral),",
        "'operating' (G_P, load plane, bilateral), 'unilateral_source' (G_S) or 'unilateral_load' (G_L) for S12≈0 designs.",
        "Returns centre (Γ and Z), radius and whether each gain is achievable, plus the reference maximum gain",
        "(MAG/MSG or G_S,max/G_L,max). Omit gains_db to get a ladder of circles below the maximum.",
        "Pass the circles to render_smith_chart to plot them.",
      ].join(" "),
      inputSchema: {
        device: deviceSchema,
        frequency: frequencySchema.optional().describe("Required with a Touchstone file."),
        type: z.enum(["available", "operating", "unilateral_source", "unilateral_load"]).default("available"),
        gains_db: z.array(z.number()).optional().describe("Gains in dB to draw (for unilateral types: the G_S / G_L block gain)."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const dev = resolveDevice(a.device, a.frequency);
      const s = dev.s;
      const st = stability(s);
      const type = a.type as GainCircleType;
      let maxDb: number;
      let maxLabel: string;
      if (type === "unilateral_source" || type === "unilateral_load") {
        maxDb = unilateralMaxDb(type === "unilateral_source" ? s.s11 : s.s22);
        maxLabel = type === "unilateral_source" ? "G_S,max" : "G_L,max";
      } else {
        const msg = abs(s.s21) / abs(s.s12);
        const stable = st.k > 1 && st.delta_magnitude < 1;
        maxDb = 10 * Math.log10(stable ? msg * (st.k - Math.sqrt(st.k ** 2 - 1)) : msg);
        maxLabel = stable ? "MAG" : "MSG";
      }
      const gains = a.gains_db ?? [0.5, 1, 2, 3].map((d) => Number((maxDb - d).toFixed(2)));
      const circles = gains.map((g) => {
        const ci = gainCircle(s, type, g);
        return { gain_db: g, plane: ci.plane, achievable: ci.achievable, center_gamma: cx(ci.center), radius: r6(ci.radius), center_z: cx(zFromGamma(ci.center, dev.z0)) };
      });
      const summary = [
        t(
          lang,
          `${type} gain circles${dev.f ? ` at ${formatSI(dev.f, "Hz")}` : ""} (${circles[0]?.plane ?? ""} plane). Reference ${maxLabel} = ${r6(maxDb)} dB.`,
          `${type} kazanç çemberleri${dev.f ? ` (${formatSI(dev.f, "Hz")})` : ""} — ${circles[0]?.plane === "source" ? "kaynak" : "yük"} düzlemi. Referans ${maxLabel} = ${r6(maxDb)} dB.`,
        ),
        ...circles.map((ci) =>
          ci.achievable
            ? `  ${ci.gain_db} dB: C = ${ci.center_gamma.mag} ∠ ${ci.center_gamma.angle_deg}°, r = ${ci.radius}`
            : t(lang, `  ${ci.gain_db} dB: not achievable`, `  ${ci.gain_db} dB: ulaşılamaz`),
        ),
        !st.unconditionally_stable && (type === "available" || type === "operating")
          ? t(lang, "⚠ Device is potentially unstable: also check stability circles.", "⚠ Cihaz potansiyel kararsız: kararlılık çemberlerini de kontrol edin.")
          : "",
        clampNote(lang, dev.clamped),
      ].filter(Boolean);
      return ok(summary.join("\n"), {
        ...(dev.f ? { frequency_hz: dev.f } : {}),
        z0: dev.z0,
        type,
        reference_max: { label: maxLabel, gain_db: r6(maxDb) },
        unconditionally_stable: st.unconditionally_stable,
        circles,
      });
    },
  );

  defineTool(
    server,
    "noise_circles",
    {
      title: "Constant noise-figure circles (LNA design)",
      description: [
        "Constant noise-figure circles in the source (ΓS) plane from the noise parameters NFmin, Γopt and Rn — taken from a",
        ".s2p noise block (interpolated at frequency) or given explicitly. Optionally evaluates the noise figure for a",
        "proposed source impedance/Γ and, if S-parameters are available, the available gain at Γopt (gain/noise trade-off).",
        "Use for low-noise amplifier (LNA) input matching.",
      ].join(" "),
      inputSchema: {
        device: deviceSchema.optional().describe("Two-port with a noise block (Touchstone) — or give the explicit noise parameters below."),
        frequency: frequencySchema.optional(),
        nf_min_db: z.number().optional().describe("Minimum noise figure NFmin in dB."),
        gamma_opt: gammaSchema.optional().describe("Optimum source reflection coefficient Γopt."),
        rn: z.number().positive().optional().describe("Equivalent noise resistance Rn in Ω (not normalized)."),
        z0: z.number().positive().optional().describe("Reference impedance (default 50 or the Touchstone value)."),
        nf_db: z.array(z.number()).optional().describe("Noise figures (dB) to draw. Default: NFmin + 0.25, 0.5, 1, 2 dB."),
        source_impedance: complexSchema.optional().describe("Evaluate NF for this source impedance."),
        source_gamma: gammaSchema.optional().describe("Evaluate NF for this source Γ."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      let noise: NoiseParams;
      let z0 = a.z0 ?? 50;
      let s: TwoPort | undefined;
      let f: number | undefined;
      let clamped = false;
      if (a.nf_min_db !== undefined && a.gamma_opt && a.rn !== undefined) {
        noise = { nf_min_db: a.nf_min_db, gamma_opt: parseGamma(a.gamma_opt), rn: a.rn };
        if (a.device && (a.device.s11 || a.device.touchstone_path || a.device.touchstone_content)) {
          const dev = resolveDevice(a.device, a.frequency);
          s = dev.s;
          f = dev.f;
        }
      } else if (a.device && (a.device.touchstone_path || a.device.touchstone_content)) {
        const dev = resolveDevice(a.device, a.frequency);
        const ts = dev.touchstone as Touchstone;
        const n = interpolateNoise(ts, dev.f as number);
        if (!n) throw new InputError("The Touchstone file has no noise-parameter block; give nf_min_db, gamma_opt and rn explicitly.");
        noise = n.noise;
        z0 = a.z0 ?? ts.z0;
        s = dev.s;
        f = dev.f;
        clamped = n.clamped;
      } else throw new InputError("Give nf_min_db + gamma_opt + rn, or a device Touchstone file with noise parameters (and frequency).");

      const nfs = a.nf_db ?? [0.25, 0.5, 1, 2].map((d) => Number((noise.nf_min_db + d).toFixed(3)));
      const circles = nfs.map((nf) => {
        const ci = noiseCircle(noise, z0, nf);
        return { nf_db: nf, achievable: ci.achievable, center_gamma: cx(ci.center), radius: r6(ci.radius), center_z: cx(zFromGamma(ci.center, z0)) };
      });
      const data: Record<string, unknown> = {
        ...(f ? { frequency_hz: f } : {}),
        z0,
        noise_parameters: { nf_min_db: r6(noise.nf_min_db), gamma_opt: cx(noise.gamma_opt), z_opt: cx(zFromGamma(noise.gamma_opt, z0)), rn_ohm: r6(noise.rn) },
        circles,
      };
      const lines = [
        t(
          lang,
          `NFmin = ${r6(noise.nf_min_db)} dB at Γopt = ${formatPolar(noise.gamma_opt)} (Zopt = ${format(zFromGamma(noise.gamma_opt, z0))} Ω), Rn = ${r6(noise.rn)} Ω.`,
          `NFmin = ${r6(noise.nf_min_db)} dB, Γopt = ${formatPolar(noise.gamma_opt)} (Zopt = ${format(zFromGamma(noise.gamma_opt, z0))} Ω), Rn = ${r6(noise.rn)} Ω.`,
        ),
        ...circles.map((ci) => `  NF ${ci.nf_db} dB: C = ${ci.center_gamma.mag} ∠ ${ci.center_gamma.angle_deg}°, r = ${ci.radius}`),
      ];
      if (s) {
        const ga = availableGain(s, noise.gamma_opt);
        data.available_gain_at_gamma_opt_db = db(ga);
        lines.push(t(lang, `Available gain with ΓS = Γopt: ${db(ga)} dB.`, `ΓS = Γopt iken mevcut kazanç: ${db(ga)} dB.`));
      }
      if (a.source_impedance !== undefined || a.source_gamma !== undefined) {
        const gs = a.source_gamma ? parseGamma(a.source_gamma) : gammaFromZ(parseComplex(a.source_impedance as never), z0);
        const nf = noiseFigureAt(noise, z0, gs);
        data.evaluated_source = { gamma: cx(gs), z: cx(zFromGamma(gs, z0)), nf_db: r6(nf), ...(s ? { available_gain_db: db(availableGain(s, gs)) } : {}) };
        lines.push(t(lang, `NF for ΓS = ${formatPolar(gs)}: ${r6(nf)} dB.`, `ΓS = ${formatPolar(gs)} için NF: ${r6(nf)} dB.`));
      }
      const note = clampNote(lang, clamped);
      if (note) lines.push(note);
      return ok(lines.join("\n"), data);
    },
  );

  defineTool(
    server,
    "conjugate_match",
    {
      title: "Simultaneous conjugate match & maximum gain",
      description: [
        "Simultaneous conjugate match of a two-port for maximum transducer gain: ΓS and ΓL (and the impedances ZS, ZL",
        "the matching networks must present to the device), GT,max (= MAG), MSG, unilateral figure of merit U and the",
        "unilateral gain error bounds. Requires K > 1 and |Δ| < 1. With design_networks=true it also synthesizes L-section",
        "input and output matching networks from the system Z0 (verified by recomputing ΓS/ΓL).",
      ].join(" "),
      inputSchema: {
        device: deviceSchema,
        frequency: frequencySchema.optional().describe("Required with a Touchstone file; also needed for design_networks."),
        design_networks: z.boolean().default(true).describe("Also design lumped L-networks for input and output (needs frequency)."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const dev = resolveDevice(a.device, a.frequency);
      const m = conjugateMatch(dev.s, dev.z0);
      const data: Record<string, unknown> = {
        ...(dev.f ? { frequency_hz: dev.f } : {}),
        z0: dev.z0,
        feasible: m.feasible,
        k: r6(m.k),
        delta_magnitude: r6(m.delta_magnitude),
        msg_db: r6(m.msg_db),
        unilateral_figure_of_merit: r6(m.unilateral_figure_of_merit),
        unilateral_error_range_db: m.unilateral_error_range_db.map(r6),
        gtu_max_db: r6(m.gtu_max_db),
      };
      if (!m.feasible) {
        data.reason = m.reason;
        return ok(
          [
            t(lang, `Simultaneous conjugate match is impossible: ${m.reason}`, `Eşzamanlı eşlenik eşleştirme mümkün değil: cihaz koşulsuz kararlı değil (K > 1 ve |Δ| < 1 gerekli).`),
            `K = ${r6(m.k)}, |Δ| = ${r6(m.delta_magnitude)}, MSG = ${r6(m.msg_db)} dB`,
            t(lang, "Use gain_circles + amplifier_stability to pick a stable ΓS/ΓL instead.", "Bunun yerine gain_circles ve amplifier_stability ile kararlı bir ΓS/ΓL seçin."),
          ].join("\n"),
          data,
        );
      }
      const gs = m.gamma_source as Complex;
      const gl = m.gamma_load as Complex;
      Object.assign(data, {
        gamma_source: cx(gs),
        gamma_load: cx(gl),
        z_source_presented_to_device: cx(m.z_source as Complex),
        z_load_presented_to_device: cx(m.z_load as Complex),
        gt_max_db: r6(m.gt_max_db as number),
      });
      const lines = [
        t(lang, `GT,max = ${r6(m.gt_max_db as number)} dB (MSG = ${r6(m.msg_db)} dB, K = ${r6(m.k)}).`, `GT,max = ${r6(m.gt_max_db as number)} dB (MSG = ${r6(m.msg_db)} dB, K = ${r6(m.k)}).`),
        t(lang, `ΓS = ${formatPolar(gs)} → ZS = ${format(m.z_source as Complex)} Ω`, `ΓS = ${formatPolar(gs)} → ZS = ${format(m.z_source as Complex)} Ω`),
        t(lang, `ΓL = ${formatPolar(gl)} → ZL = ${format(m.z_load as Complex)} Ω`, `ΓL = ${formatPolar(gl)} → ZL = ${format(m.z_load as Complex)} Ω`),
      ];
      if (a.design_networks) {
        if (!dev.f) throw new InputError("frequency is required for design_networks");
        const design = (target: Complex, side: "input" | "output") => {
          // network sits between the Z0 termination and the device; looking from the device it must show `target`
          return lMatchRaw(c(dev.z0), target).map((r, i) => {
            const comps = rawToComponents(r.elements, dev.f as number, dev.z0);
            return {
              id: i + 1,
              order: side === "input" ? "from Z0 generator → device input" : "from Z0 load → device output",
              description: comps.map(describeComponent).join(" → ") || "none",
              response: responseType(comps),
              components: comps.map(toComponentInput),
            };
          });
        };
        data.input_networks = design(m.z_source as Complex, "input");
        data.output_networks = design(m.z_load as Complex, "output");
        const fi = (data.input_networks as { description: string }[])[0];
        const fo = (data.output_networks as { description: string }[])[0];
        lines.push(
          t(lang, `Input network #1 (Z0 → device): ${fi?.description}`, `Giriş ağı #1 (Z0 → cihaz): ${fi?.description}`),
          t(lang, `Output network #1 (Z0 load → device): ${fo?.description}`, `Çıkış ağı #1 (Z0 yük → cihaz): ${fo?.description}`),
        );
      }
      const note = clampNote(lang, dev.clamped);
      if (note) lines.push(note);
      return ok(lines.join("\n"), data);
    },
  );
}

