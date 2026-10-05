import { readFileSync } from "node:fs";

import { z } from "zod";

import { filesystemAllowed } from "../config.ts";
import { type Component, type LoadFn, tableLookup } from "../core/circuit.ts";
import { type Complex, c, fromPolar } from "../core/complex.ts";
import { zFromGamma } from "../core/rf.ts";
import { interpolateSParams, parseTouchstone, type Touchstone, type TwoPort } from "../core/sparams.ts";
import { parseLength, parseQuantity, type QuantityKind } from "../core/units.ts";

// ---------------------------------------------------------------- primitives

export const languageSchema = z
  .enum(["en", "tr"])
  .optional()
  .describe("Language of the human-readable summary: 'en' (English) or 'tr' (Türkçe). Defaults to the server setting.");

const quantity = (kind: string, example: string) =>
  z
    .union([z.number(), z.string()])
    .describe(`${kind}. Number in SI base units or engineering string, e.g. ${example}`);

export const frequencySchema = quantity("Frequency", "2.4e9, '2.4GHz', '915 MHz'");
export const inductanceSchema = quantity("Inductance", "'10nH', 1e-8");
export const capacitanceSchema = quantity("Capacitance", "'1.5pF', '2.2u'");
export const resistanceSchema = quantity("Resistance", "50, '4k7', '1.2 kΩ'");
export const lengthSchema = z
  .union([z.number(), z.string()])
  .describe("Length: electrical ('0.25λ', '0.125 lambda', '90deg') or physical ('12.5mm', '3 cm', '500mil'). Bare numbers are meters.");

export const z0Schema = z.number().positive().default(50).describe("Reference (system) characteristic impedance Z0 in Ω. Default 50.");

export const complexSchema = z
  .union([
    z.object({ re: z.number().describe("Real part (resistance) Ω"), im: z.number().describe("Imaginary part (reactance) Ω") }),
    z.string(),
    z.number(),
  ])
  .describe("Complex impedance: {re, im}, a string like '25-j15', '25 - 15j', '100', 'j50', or a real number.");

export const gammaSchema = z
  .union([
    z.object({ mag: z.number().min(0).describe("|Γ| magnitude (linear)"), angle_deg: z.number().describe("Angle in degrees") }),
    z.object({ re: z.number(), im: z.number() }),
  ])
  .describe("Reflection coefficient: polar {mag, angle_deg} or rectangular {re, im}.");

export class InputError extends Error {}

export function parseComplex(input: z.infer<typeof complexSchema>): Complex {
  if (typeof input === "number") return c(input);
  if (typeof input === "object") return c(input.re, input.im);
  const s = input.replace(/\s+/g, "").replace(/Ω|ohms?/gi, "").replace(/[−–]/g, "-").replace(/i/g, "j");
  if (s === "") throw new InputError("Empty complex number");
  const num = "(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
  let m = s.match(new RegExp(`^([-+]?${num})?(?:([-+])j(${num})?|([-+])(${num})j)?$`));
  if (m && (m[1] !== undefined || m[2] !== undefined || m[4] !== undefined)) {
    const re = m[1] !== undefined ? Number(m[1]) : 0;
    let im = 0;
    if (m[2] !== undefined) im = (m[2] === "-" ? -1 : 1) * (m[3] !== undefined ? Number(m[3]) : 1);
    else if (m[4] !== undefined) im = (m[4] === "-" ? -1 : 1) * Number(m[5]);
    return c(re, im);
  }
  m = s.match(new RegExp(`^([-+]?)j(${num})?$`)) ?? s.match(new RegExp(`^([-+]?)(${num})j$`));
  if (m) return c(0, (m[1] === "-" ? -1 : 1) * (m[2] !== undefined ? Number(m[2]) : 1));
  throw new InputError(`Cannot parse complex number "${input}" (try '25-j15' or {re:25, im:-15})`);
}

export const parseGamma = (g: z.infer<typeof gammaSchema>): Complex =>
  "mag" in g ? fromPolar(g.mag, g.angle_deg) : c(g.re, g.im);

export const q = (v: number | string, kind: QuantityKind): number => {
  try {
    return parseQuantity(v, kind);
  } catch (e) {
    throw new InputError((e as Error).message);
  }
};

// ---------------------------------------------------------------- touchstone

export const touchstoneSourceSchema = {
  touchstone_path: z
    .string()
    .optional()
    .describe("Absolute path to a Touchstone v1 file (.s1p / .s2p) on the server machine (local/stdio servers only; remote servers need touchstone_content)."),
  touchstone_content: z.string().optional().describe("Raw Touchstone v1 text (alternative to touchstone_path)."),
};

export function loadTouchstone(src: { touchstone_path?: string; touchstone_content?: string }): Touchstone {
  let text = src.touchstone_content;
  let hint: 1 | 2 | undefined;
  if (!text && src.touchstone_path) {
    if (!filesystemAllowed())
      throw new InputError("touchstone_path is disabled on this remote server; paste the file text into touchstone_content instead");
    try {
      text = readFileSync(src.touchstone_path, "utf8");
    } catch (e) {
      throw new InputError(`Cannot read Touchstone file: ${(e as Error).message}`);
    }
    const ext = src.touchstone_path.toLowerCase().match(/\.s([12])p$/);
    if (ext) hint = Number(ext[1]) as 1 | 2;
  }
  if (!text) throw new InputError("Provide touchstone_path or touchstone_content");
  try {
    return parseTouchstone(text, hint);
  } catch (e) {
    throw new InputError((e as Error).message);
  }
}

// ---------------------------------------------------------------- load

export const loadSchema = z
  .object({
    z: complexSchema.optional().describe("Constant load impedance, e.g. '25-j15' or {re:25, im:-15}."),
    gamma: gammaSchema.optional().describe("Load given as reflection coefficient relative to Z0."),
    table: z
      .array(z.object({ f: frequencySchema, re: z.number(), im: z.number() }))
      .optional()
      .describe("Frequency-dependent load Z(f) table, interpolated between points."),
    interpolation: z.enum(["linear", "hold"]).optional().describe("Interpolation for table loads (default linear)."),
    ...touchstoneSourceSchema,
  })
  .describe(
    "The load (termination) at the far end of the circuit. Give exactly one of: z, gamma, table, or a 1-port Touchstone (.s1p) via touchstone_path / touchstone_content (e.g. a measured antenna).",
  );

export type LoadInput = z.infer<typeof loadSchema>;

export function resolveLoad(load: LoadInput, z0: number): { fn: LoadFn; describe: string; touchstone?: Touchstone } {
  const given = [load.z !== undefined, load.gamma !== undefined, load.table !== undefined, !!(load.touchstone_path || load.touchstone_content)].filter(
    Boolean,
  ).length;
  if (given !== 1) throw new InputError("load: provide exactly one of z, gamma, table, touchstone_path/touchstone_content");
  if (load.z !== undefined) {
    const zl = parseComplex(load.z);
    return { fn: () => zl, describe: "constant" };
  }
  if (load.gamma !== undefined) {
    const zl = zFromGamma(parseGamma(load.gamma), z0);
    return { fn: () => zl, describe: "constant (from Γ)" };
  }
  if (load.table) {
    const table = load.table.map((p) => ({ f: q(p.f, "frequency"), z: c(p.re, p.im) })).sort((a, b) => a.f - b.f);
    const mode = load.interpolation ?? "linear";
    return {
      fn: (f) => tableLookup(table, f, mode),
      describe: `table (${table.length} points)`,
    };
  }
  const ts = loadTouchstone(load);
  return {
    fn: (f) => zFromGamma(interpolateSParams(ts, f).s.s11, ts.z0),
    describe: `Touchstone ${ts.ports}-port S11, ${ts.points.length} points`,
    touchstone: ts,
  };
}

// ---------------------------------------------------------------- components

const placement = z.enum(["series", "shunt"]).describe("'series' = in line with the signal path, 'shunt' = from the signal path to ground.");
const common = {
  label: z.string().optional().describe("Optional label shown in results and on the chart."),
  tolerance_pct: z.number().min(0).max(100).optional().describe("± tolerance in percent for corner analysis."),
};
const lineCommon = {
  z0: z.number().positive().optional().describe("Characteristic impedance of this line in Ω (defaults to the system Z0)."),
  length: lengthSchema,
  eps_eff: z.number().min(1).optional().describe("Effective relative permittivity (default 1 = air). Ignored if velocity_factor is set."),
  velocity_factor: z.number().gt(0).max(1).optional().describe("Velocity factor (e.g. 0.66 for RG-58). Sets eps_eff = 1/vf²."),
  loss_db_per_m: z.number().min(0).optional().describe("Line attenuation in dB per meter (default 0 = lossless)."),
};

export const componentSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("inductor"),
      placement,
      value: inductanceSchema,
      q: z.number().positive().optional().describe("Unloaded quality factor (adds R = ωL/Q)."),
      esr: z.number().min(0).optional().describe("Equivalent series resistance Ω."),
      ...common,
    }),
    z.object({
      type: z.literal("capacitor"),
      placement,
      value: capacitanceSchema,
      q: z.number().positive().optional().describe("Quality factor (adds R = 1/(ωCQ))."),
      esr: z.number().min(0).optional().describe("Equivalent series resistance Ω."),
      esl: inductanceSchema.optional().describe("Equivalent series inductance, e.g. '0.5nH'."),
      ...common,
    }),
    z.object({
      type: z.literal("resistor"),
      placement,
      value: resistanceSchema,
      esl: inductanceSchema.optional().describe("Parasitic series inductance."),
      ...common,
    }),
    z.object({
      type: z.literal("rlc"),
      placement,
      arrangement: z.enum(["series", "parallel"]).describe("How R, L and C are connected to each other (series RLC or parallel tank)."),
      r: resistanceSchema.optional(),
      l: inductanceSchema.optional(),
      c: capacitanceSchema.optional(),
      ...common,
    }),
    z.object({
      type: z.literal("impedance"),
      placement,
      z: complexSchema.optional().describe("Constant impedance of the element."),
      table: z
        .array(z.object({ f: frequencySchema, re: z.number(), im: z.number() }))
        .optional()
        .describe("Frequency-dependent impedance table (custom Z(f) block)."),
      interpolation: z.enum(["linear", "hold"]).optional(),
      ...common,
    }),
    z.object({ type: z.literal("transmission_line"), ...lineCommon, ...common }),
    z.object({
      type: z.literal("stub"),
      termination: z.enum(["open", "short"]).describe("Stub end termination."),
      placement: placement.optional().describe("'shunt' (default, parallel stub) or 'series' stub."),
      ...lineCommon,
      ...common,
    }),
    z.object({
      type: z.literal("transformer"),
      turns_ratio: z.number().positive().describe("Ideal transformer ratio N (source:load). Impedance seen = N² × load-side impedance."),
      label: common.label,
    }),
    z.object({
      type: z.literal("coupled_inductors"),
      l_load: inductanceSchema.describe("Winding inductance on the load side."),
      l_source: inductanceSchema.describe("Winding inductance on the source side."),
      k: z.number().min(0).max(1).describe("Coupling coefficient 0..1."),
      label: common.label,
    }),
  ])
  .describe("One circuit element. Elements are listed from the LOAD towards the SOURCE.");

export type ComponentInput = z.infer<typeof componentSchema>;

export function resolveComponent(ci: ComponentInput, z0: number): Component {
  const base = { label: ci.label, tolerance_pct: "tolerance_pct" in ci ? ci.tolerance_pct : undefined };
  switch (ci.type) {
    case "inductor":
      return { ...base, type: "inductor", placement: ci.placement, l: q(ci.value, "inductance"), q: ci.q, esr: ci.esr };
    case "capacitor":
      return {
        ...base,
        type: "capacitor",
        placement: ci.placement,
        c: q(ci.value, "capacitance"),
        q: ci.q,
        esr: ci.esr,
        esl: ci.esl !== undefined ? q(ci.esl, "inductance") : undefined,
      };
    case "resistor":
      return {
        ...base,
        type: "resistor",
        placement: ci.placement,
        r: q(ci.value, "resistance"),
        esl: ci.esl !== undefined ? q(ci.esl, "inductance") : undefined,
      };
    case "rlc":
      if (ci.r === undefined && ci.l === undefined && ci.c === undefined) throw new InputError("rlc: give at least one of r, l, c");
      return {
        ...base,
        type: "rlc",
        placement: ci.placement,
        arrangement: ci.arrangement,
        r: ci.r !== undefined ? q(ci.r, "resistance") : undefined,
        l: ci.l !== undefined ? q(ci.l, "inductance") : undefined,
        c: ci.c !== undefined ? q(ci.c, "capacitance") : undefined,
      };
    case "impedance":
      if (!ci.z && !ci.table) throw new InputError("impedance: give z or table");
      return {
        ...base,
        type: "impedance",
        placement: ci.placement,
        z: ci.z !== undefined ? parseComplex(ci.z) : undefined,
        table: ci.table?.map((p) => ({ f: q(p.f, "frequency"), z: c(p.re, p.im) })),
        interpolation: ci.interpolation,
      };
    case "transmission_line":
    case "stub": {
      let length: ReturnType<typeof parseLength>;
      try {
        length = parseLength(ci.length);
      } catch (e) {
        throw new InputError((e as Error).message);
      }
      const eps = ci.velocity_factor ? 1 / ci.velocity_factor ** 2 : (ci.eps_eff ?? 1);
      const line = { z0: ci.z0 ?? z0, length, eps_eff: eps, loss_db_per_m: ci.loss_db_per_m ?? 0 };
      return ci.type === "transmission_line"
        ? { ...base, type: "transmission_line", ...line }
        : { ...base, type: "stub", termination: ci.termination, placement: ci.placement ?? "shunt", ...line };
    }
    case "transformer":
      return { label: ci.label, type: "transformer", turns_ratio: ci.turns_ratio };
    case "coupled_inductors":
      return {
        label: ci.label,
        type: "coupled_inductors",
        l_load: q(ci.l_load, "inductance"),
        l_source: q(ci.l_source, "inductance"),
        k: ci.k,
      };
  }
}

// ---------------------------------------------------------------- sweep

export const sweepSchema = z
  .object({
    start: frequencySchema.optional().describe("Sweep start frequency."),
    stop: frequencySchema.optional().describe("Sweep stop frequency."),
    span: frequencySchema.optional().describe("Total span centred on the design frequency (alternative to start/stop)."),
    points: z.number().int().min(2).max(2001).optional().describe("Number of points (default 101)."),
    scale: z.enum(["linear", "log"]).optional().describe("Point spacing (default linear)."),
  })
  .describe("Frequency sweep: give start+stop, or span (centred on frequency).");

export function resolveSweep(s: z.infer<typeof sweepSchema>, f0: number) {
  let start: number;
  let stop: number;
  if (s.start !== undefined && s.stop !== undefined) {
    start = q(s.start, "frequency");
    stop = q(s.stop, "frequency");
  } else if (s.span !== undefined) {
    const span = q(s.span, "frequency");
    start = f0 - span / 2;
    stop = f0 + span / 2;
  } else throw new InputError("sweep: give start+stop or span");
  if (!(start > 0 && stop > start)) throw new InputError("sweep: need 0 < start < stop");
  return { start, stop, points: s.points ?? 101, scale: s.scale ?? ("linear" as const) };
}

// ---------------------------------------------------------------- two-port

export const deviceSchema = z
  .object({
    s11: gammaSchema.optional(),
    s21: gammaSchema.optional(),
    s12: gammaSchema.optional(),
    s22: gammaSchema.optional(),
    z0: z.number().positive().optional().describe("Reference impedance of the S-parameters (default 50, or from the Touchstone file)."),
    ...touchstoneSourceSchema,
  })
  .describe(
    "Two-port device: either all four S-parameters (s11, s21, s12, s22 as {mag, angle_deg} or {re, im}) or a 2-port Touchstone file via touchstone_path / touchstone_content.",
  );

export function resolveDevice(
  d: z.infer<typeof deviceSchema>,
  frequency?: number | string,
): { s: TwoPort; z0: number; f?: number; touchstone?: Touchstone; clamped: boolean } {
  if (d.touchstone_path || d.touchstone_content) {
    const ts = loadTouchstone(d);
    if (ts.ports !== 2) throw new InputError("A 2-port (.s2p) Touchstone file is required");
    if (frequency === undefined) throw new InputError("frequency is required when using a Touchstone file");
    const f = q(frequency, "frequency");
    const { s, clamped } = interpolateSParams(ts, f);
    return { s, z0: d.z0 ?? ts.z0, f, touchstone: ts, clamped };
  }
  if (!d.s11 || !d.s21 || !d.s12 || !d.s22) throw new InputError("device: give s11, s21, s12, s22 or a Touchstone file");
  return {
    s: { s11: parseGamma(d.s11), s21: parseGamma(d.s21), s12: parseGamma(d.s12), s22: parseGamma(d.s22) },
    z0: d.z0 ?? 50,
    f: frequency !== undefined ? q(frequency, "frequency") : undefined,
    clamped: false,
  };
}
