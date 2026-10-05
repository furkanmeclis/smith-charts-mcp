import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { inputImpedance, lengthMeters } from "../core/circuit.ts";
import { abs, argDeg, type Complex, c, format, formatPolar, inv, scale } from "../core/complex.ts";
import { gammaFromZ, impedanceMetrics, reactanceToElement, susceptanceToElement, zFromGamma } from "../core/rf.ts";
import { formatSI, type Length, parseLength, SPEED_OF_LIGHT } from "../core/units.ts";
import { resolveLang, t } from "../i18n/index.ts";
import { cx, defineTool, ok, r6 } from "./format.ts";
import {
  complexSchema,
  frequencySchema,
  gammaSchema,
  InputError,
  languageSchema,
  lengthSchema,
  parseComplex,
  parseGamma,
  q,
  z0Schema,
} from "./schemas.ts";

export function elementEquivalents(zIn: Complex, f: number) {
  const w = 2 * Math.PI * f;
  const s = reactanceToElement(zIn.im, w);
  const y = inv(zIn);
  const p = susceptanceToElement(y.im, w);
  return {
    series_model: {
      resistance_ohm: r6(zIn.re),
      reactive_element: s ? { kind: s.kind, value: r6(s.value), pretty: formatSI(s.value, s.kind === "inductor" ? "H" : "F") } : null,
    },
    parallel_model: {
      resistance_ohm: r6(y.re === 0 ? Number.POSITIVE_INFINITY : 1 / y.re),
      reactive_element: p ? { kind: p.kind, value: r6(p.value), pretty: formatSI(p.value, p.kind === "inductor" ? "H" : "F") } : null,
    },
  };
}

export function metricsJson(z: Complex, z0: number) {
  const m = impedanceMetrics(z, z0);
  return {
    z: cx(z),
    z_normalized: cx(scale(z, 1 / z0)),
    y_siemens: cx(inv(z)),
    y_normalized: cx(scale(inv(z), z0)),
    gamma: cx(gammaFromZ(z, z0)),
    vswr: m.vswr,
    return_loss_db: m.return_loss_db,
    mismatch_loss_db: m.mismatch_loss_db,
    power_delivered_pct: m.power_delivered_pct,
    q_factor: m.q,
  };
}

export function registerConvertTools(server: McpServer): void {
  defineTool(
    server,
    "impedance_convert",
    {
      title: "Impedance / admittance / reflection-coefficient converter",
      description: [
        "Convert one RF quantity into all the others for a reference impedance Z0:",
        "impedance Z ↔ normalized z ↔ admittance Y ↔ reflection coefficient Γ (S11), plus VSWR, return loss,",
        "mismatch loss, delivered power and Q. Give exactly ONE of: z, z_normalized, y, gamma, or vswr (+ optional gamma_angle_deg).",
        "With a frequency, also returns the equivalent series and parallel R + L/C element values.",
        "Use for: 'what is the VSWR of 75 Ω on 50 Ω?', 'convert S11 = 0.5∠30° to impedance', 'return loss of 25-j15 Ω'.",
      ].join(" "),
      inputSchema: {
        z: complexSchema.optional().describe("Impedance in Ω, e.g. '25-j15'."),
        z_normalized: complexSchema.optional().describe("Normalized impedance z = Z/Z0, e.g. '0.5+j1'."),
        y: complexSchema.optional().describe("Admittance in siemens, e.g. {re:0.02, im:-0.01}."),
        gamma: gammaSchema.optional().describe("Reflection coefficient Γ / S11."),
        vswr: z.number().min(1).optional().describe("VSWR (≥1). Combined with gamma_angle_deg (default 0) to build Γ."),
        return_loss_db: z.number().min(0).optional().describe("Return loss in dB (positive). Combined with gamma_angle_deg."),
        gamma_angle_deg: z.number().optional().describe("Phase of Γ in degrees when using vswr or return_loss_db."),
        z0: z0Schema,
        frequency: frequencySchema.optional().describe("Optional frequency to compute equivalent L/C values."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const given = [a.z, a.z_normalized, a.y, a.gamma, a.vswr, a.return_loss_db].filter((v) => v !== undefined).length;
      if (given !== 1) throw new InputError("Give exactly one of z, z_normalized, y, gamma, vswr, return_loss_db");
      let zv: Complex;
      if (a.z !== undefined) zv = parseComplex(a.z);
      else if (a.z_normalized !== undefined) zv = scale(parseComplex(a.z_normalized), a.z0);
      else if (a.y !== undefined) zv = inv(parseComplex(a.y));
      else if (a.gamma !== undefined) zv = zFromGamma(parseGamma(a.gamma), a.z0);
      else {
        const mag = a.vswr !== undefined ? (a.vswr - 1) / (a.vswr + 1) : 10 ** (-(a.return_loss_db as number) / 20);
        const ang = ((a.gamma_angle_deg ?? 0) * Math.PI) / 180;
        zv = zFromGamma(c(mag * Math.cos(ang), mag * Math.sin(ang)), a.z0);
      }
      const data: Record<string, unknown> = { z0: a.z0, ...metricsJson(zv, a.z0) };
      if (a.frequency !== undefined) {
        const f = q(a.frequency, "frequency");
        data.frequency_hz = f;
        data.equivalent_circuit = elementEquivalents(zv, f);
      }
      const g = gammaFromZ(zv, a.z0);
      const m = impedanceMetrics(zv, a.z0);
      const summary = [
        t(lang, `Z = ${format(zv)} Ω (Z0 = ${a.z0} Ω)`, `Z = ${format(zv)} Ω (Z0 = ${a.z0} Ω)`),
        t(lang, `Γ = ${formatPolar(g)}  |  VSWR = ${r6(m.vswr)}  |  Return loss = ${r6(m.return_loss_db)} dB`, `Γ = ${formatPolar(g)}  |  VSWR = ${r6(m.vswr)}  |  Geri dönüş kaybı = ${r6(m.return_loss_db)} dB`),
        t(
          lang,
          `Mismatch loss = ${r6(m.mismatch_loss_db)} dB (${r6(m.power_delivered_pct)} % of power delivered), Q = ${m.q}`,
          `Uyumsuzluk kaybı = ${r6(m.mismatch_loss_db)} dB (gücün % ${r6(m.power_delivered_pct)}'i yüke aktarılır), Q = ${m.q}`,
        ),
      ];
      return ok(summary.join("\n"), data);
    },
  );

  defineTool(
    server,
    "tline_input_impedance",
    {
      title: "Transmission line input impedance",
      description: [
        "Input impedance of a (lossy or lossless) transmission line terminated in a load:",
        "Zin = Z0·(ZL + Z0·tanh γℓ)/(Z0 + ZL·tanh γℓ). Length can be electrical (λ, degrees) or physical (mm, m, mil)",
        "with eps_eff / velocity_factor. Also returns Γ at load and input, electrical/physical length, guided wavelength,",
        "and the distances from the load to the first voltage maximum and minimum.",
        "Use for coax/microstrip/λ/4/λ/2 line questions and 'where is the voltage minimum?' problems.",
      ].join(" "),
      inputSchema: {
        load: complexSchema.optional().describe("Load impedance ZL in Ω (use 'open' via a huge value or give load_gamma)."),
        load_gamma: gammaSchema.optional().describe("Alternatively the load reflection coefficient (relative to line_z0)."),
        load_type: z.enum(["open", "short"]).optional().describe("Shortcut for open- or short-circuit loads."),
        line_z0: z.number().positive().optional().describe("Characteristic impedance of the line (default = z0)."),
        length: lengthSchema,
        frequency: frequencySchema.optional().describe("Required for physical lengths, loss and for converting to physical length."),
        eps_eff: z.number().min(1).optional().describe("Effective permittivity (default 1)."),
        velocity_factor: z.number().gt(0).max(1).optional().describe("Velocity factor; overrides eps_eff."),
        loss_db_per_m: z.number().min(0).optional().describe("Attenuation in dB/m (needs a physical frequency)."),
        z0: z0Schema.describe("System reference impedance used for Γ / VSWR at the input. Default 50."),
        language: languageSchema,
      },
    },
    (a) => {
      const lang = resolveLang(a.language);
      const lineZ0 = a.line_z0 ?? a.z0;
      const eps = a.velocity_factor ? 1 / a.velocity_factor ** 2 : (a.eps_eff ?? 1);
      let zl: Complex;
      const nLoads = [a.load, a.load_gamma, a.load_type].filter((v) => v !== undefined).length;
      if (nLoads !== 1) throw new InputError("Give exactly one of load, load_gamma, load_type");
      if (a.load_type === "open") zl = c(Number.POSITIVE_INFINITY);
      else if (a.load_type === "short") zl = c(0);
      else if (a.load_gamma) zl = zFromGamma(parseGamma(a.load_gamma), lineZ0);
      else zl = parseComplex(a.load as never);

      let len: Length;
      try {
        len = parseLength(a.length);
      } catch (e) {
        throw new InputError((e as Error).message);
      }
      const physical = len.kind === "physical";
      if ((physical || (a.loss_db_per_m ?? 0) > 0) && a.frequency === undefined)
        throw new InputError("frequency is required for physical lengths or lossy lines");
      const f = a.frequency !== undefined ? q(a.frequency, "frequency") : 1e9;
      const meters = lengthMeters(len, f, eps);
      const wavelengths = (meters * f * Math.sqrt(eps)) / SPEED_OF_LIGHT;
      const zin = inputImpedance(
        zl,
        [{ type: "transmission_line", z0: lineZ0, length: len, eps_eff: eps, loss_db_per_m: a.loss_db_per_m ?? 0 }],
        f,
        f,
      );
      const gl = gammaFromZ(zl, lineZ0);
      const phi = ((argDeg(gl) % 360) + 360) % 360;
      const dMax = (phi / 720) % 0.5;
      const dMin = (dMax + 0.25) % 0.5;
      const lambdaG = SPEED_OF_LIGHT / (f * Math.sqrt(eps));
      const data: Record<string, unknown> = {
        line_z0: lineZ0,
        eps_eff: r6(eps),
        electrical_length: { wavelengths: r6(wavelengths), degrees: r6(wavelengths * 360) },
        ...(a.frequency !== undefined
          ? { frequency_hz: f, physical_length_m: r6(meters), guided_wavelength_m: r6(lambdaG) }
          : {}),
        load: { z: cx(zl), gamma_on_line: cx(gl), vswr_on_line: r6(abs(gl) >= 1 ? Number.POSITIVE_INFINITY : (1 + abs(gl)) / (1 - abs(gl))) },
        input: metricsJson(zin, a.z0),
        standing_wave: {
          first_voltage_max_from_load_wavelengths: r6(dMax),
          first_voltage_min_from_load_wavelengths: r6(dMin),
          ...(a.frequency !== undefined ? { first_voltage_max_m: r6(dMax * lambdaG), first_voltage_min_m: r6(dMin * lambdaG) } : {}),
        },
      };
      const summary = [
        t(
          lang,
          `Line Z0 = ${lineZ0} Ω, length = ${r6(wavelengths)} λ (${r6(wavelengths * 360)}°)${a.frequency !== undefined ? ` = ${formatSI(meters, "m")}` : ""}`,
          `Hat Z0 = ${lineZ0} Ω, uzunluk = ${r6(wavelengths)} λ (${r6(wavelengths * 360)}°)${a.frequency !== undefined ? ` = ${formatSI(meters, "m")}` : ""}`,
        ),
        t(lang, `Zin = ${format(zin)} Ω`, `Giriş empedansı Zin = ${format(zin)} Ω`),
        t(
          lang,
          `First voltage max / min from load: ${r6(dMax)} λ / ${r6(dMin)} λ`,
          `Yükten ilk gerilim maksimumu / minimumu: ${r6(dMax)} λ / ${r6(dMin)} λ`,
        ),
      ];
      return ok(summary.join("\n"), data);
    },
  );
}
