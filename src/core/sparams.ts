import {
  abs,
  abs2,
  add,
  type Complex,
  c,
  conj,
  div,
  fromPolar,
  mul,
  ONE,
  scale,
  sub,
} from "./complex.ts";
import { fromDB10, zFromGamma } from "./rf.ts";

export interface TwoPort {
  s11: Complex;
  s21: Complex;
  s12: Complex;
  s22: Complex;
}

export interface NoiseParams {
  /** Minimum noise figure, dB */
  nf_min_db: number;
  gamma_opt: Complex;
  /** Equivalent noise resistance, Ω (not normalised) */
  rn: number;
}

export interface TouchstonePoint {
  frequency: number;
  s: TwoPort | { s11: Complex };
}

export interface Touchstone {
  ports: 1 | 2;
  z0: number;
  format: "MA" | "DB" | "RI";
  frequency_unit: string;
  points: { frequency: number; s11: Complex; s21?: Complex; s12?: Complex; s22?: Complex }[];
  noise: ({ frequency: number } & NoiseParams)[];
  warnings: string[];
}

export class TouchstoneError extends Error {}

const FREQ_MULT: Record<string, number> = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9, THZ: 1e12 };

function pair(a: number, b: number, format: Touchstone["format"]): Complex {
  if (format === "RI") return c(a, b);
  if (format === "DB") return fromPolar(10 ** (a / 20), b);
  return fromPolar(a, b);
}

/**
 * Touchstone v1 parser (.s1p / .s2p). Supports MA/DB/RI, any frequency unit,
 * comments, line-wrapped 2-port data and the trailing noise-parameter block.
 */
export function parseTouchstone(text: string, portsHint?: 1 | 2): Touchstone {
  let unit = "GHZ";
  let param = "S";
  let format: Touchstone["format"] = "MA";
  let z0 = 50;
  const warnings: string[] = [];
  const rows: number[][] = [];
  let optionSeen = false;

  for (const rawLine of text.replace(/–|−/g, "-").split(/\r?\n/)) {
    const line = rawLine.split("!")[0].trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (optionSeen) continue;
      optionSeen = true;
      const tok = line.slice(1).trim().toUpperCase().split(/\s+/).filter(Boolean);
      for (let i = 0; i < tok.length; i++) {
        const t = tok[i];
        if (t in FREQ_MULT) unit = t;
        else if (["S", "Y", "Z", "H", "G"].includes(t)) param = t;
        else if (t === "MA" || t === "DB" || t === "RI") format = t;
        else if (t === "R" && tok[i + 1]) z0 = Number.parseFloat(tok[++i]);
      }
      continue;
    }
    if (line.startsWith("[")) throw new TouchstoneError("Touchstone v2 keyword syntax is not supported; use v1 format");
    const nums = line.split(/[\s,]+/).map(Number);
    if (nums.some((n) => Number.isNaN(n))) throw new TouchstoneError(`Non-numeric data line: "${rawLine.trim()}"`);
    rows.push(nums);
  }
  if (param !== "S") throw new TouchstoneError(`Only S-parameter files are supported (file declares ${param})`);
  if (rows.length === 0) throw new TouchstoneError("No data lines found");

  const ports: 1 | 2 = portsHint ?? (rows[0].length === 3 ? 1 : 2);
  const perPoint = ports === 1 ? 3 : 9;
  const fm = FREQ_MULT[unit];
  const points: Touchstone["points"] = [];
  const noise: Touchstone["noise"] = [];

  let buffer: number[] = [];
  let i = 0;
  for (; i < rows.length; i++) {
    const row = rows[i];
    // noise block: 5-value rows whose frequency does not increase
    if (
      ports === 2 &&
      buffer.length === 0 &&
      row.length === 5 &&
      points.length > 0 &&
      row[0] * fm <= points[points.length - 1].frequency
    )
      break;
    buffer.push(...row);
    while (buffer.length >= perPoint) {
      const v = buffer.splice(0, perPoint);
      const f = v[0] * fm;
      if (ports === 1) points.push({ frequency: f, s11: pair(v[1], v[2], format) });
      else
        points.push({
          frequency: f,
          s11: pair(v[1], v[2], format),
          s21: pair(v[3], v[4], format),
          s12: pair(v[5], v[6], format),
          s22: pair(v[7], v[8], format),
        });
    }
  }
  if (buffer.length > 0) warnings.push(`Ignored ${buffer.length} trailing values (incomplete data point)`);
  for (; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 5) {
      warnings.push(`Ignored malformed noise line with ${r.length} values`);
      continue;
    }
    noise.push({ frequency: r[0] * fm, nf_min_db: r[1], gamma_opt: fromPolar(r[2], r[3]), rn: r[4] * z0 });
  }
  points.sort((a, b) => a.frequency - b.frequency);
  for (let k = 1; k < points.length; k++)
    if (points[k].frequency === points[k - 1].frequency) warnings.push(`Duplicate frequency ${points[k].frequency} Hz`);
  return { ports, z0, format, frequency_unit: unit, points, noise, warnings };
}

const lerpC = (a: Complex, b: Complex, t: number): Complex => add(a, scale(sub(b, a), t));

function bracket<T extends { frequency: number }>(arr: T[], f: number): { a: T; b: T; t: number; clamped: boolean } {
  if (arr.length === 0) throw new TouchstoneError("No data points");
  if (f <= arr[0].frequency) return { a: arr[0], b: arr[0], t: 0, clamped: f < arr[0].frequency };
  const last = arr[arr.length - 1];
  if (f >= last.frequency) return { a: last, b: last, t: 0, clamped: f > last.frequency };
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].frequency <= f) lo = mid;
    else hi = mid;
  }
  const a = arr[lo];
  const b = arr[hi];
  return { a, b, t: (f - a.frequency) / (b.frequency - a.frequency), clamped: false };
}

/** Linear (real/imag) interpolation of S-parameters at f. Clamps outside the data range. */
export function interpolateSParams(ts: Touchstone, f: number): { s: TwoPort; clamped: boolean } {
  const { a, b, t, clamped } = bracket(ts.points, f);
  const z = c(0);
  return {
    clamped,
    s: {
      s11: lerpC(a.s11, b.s11, t),
      s21: lerpC(a.s21 ?? z, b.s21 ?? z, t),
      s12: lerpC(a.s12 ?? z, b.s12 ?? z, t),
      s22: lerpC(a.s22 ?? z, b.s22 ?? z, t),
    },
  };
}

export function interpolateNoise(ts: Touchstone, f: number): { noise: NoiseParams; clamped: boolean } | null {
  if (ts.noise.length === 0) return null;
  const { a, b, t, clamped } = bracket(ts.noise, f);
  return {
    clamped,
    noise: {
      nf_min_db: a.nf_min_db + (b.nf_min_db - a.nf_min_db) * t,
      gamma_opt: lerpC(a.gamma_opt, b.gamma_opt, t),
      rn: a.rn + (b.rn - a.rn) * t,
    },
  };
}

// ---------------------------------------------------------------- stability

export interface Circle {
  /** Centre in the Γ plane */
  center: Complex;
  radius: number;
}

export interface StabilityResult {
  delta: Complex;
  delta_magnitude: number;
  k: number;
  mu_source: number;
  mu_load: number;
  unconditionally_stable: boolean;
  /** Load-plane (output) stability circle */
  load_circle: Circle & { stable_region: "inside" | "outside" };
  /** Source-plane (input) stability circle */
  source_circle: Circle & { stable_region: "inside" | "outside" };
}

const deltaOf = (s: TwoPort): Complex => sub(mul(s.s11, s.s22), mul(s.s12, s.s21));

export function stability(s: TwoPort): StabilityResult {
  const d = deltaOf(s);
  const dm = abs(d);
  const s11 = abs(s.s11);
  const s22 = abs(s.s22);
  const s12s21 = abs(mul(s.s12, s.s21));
  const k = (1 - s11 ** 2 - s22 ** 2 + dm ** 2) / (2 * s12s21);
  const muLoad = (1 - s11 ** 2) / (abs(sub(s.s22, mul(d, conj(s.s11)))) + s12s21);
  const muSource = (1 - s22 ** 2) / (abs(sub(s.s11, mul(d, conj(s.s22)))) + s12s21);

  const denL = s22 ** 2 - dm ** 2;
  const cl = scale(conj(sub(s.s22, mul(d, conj(s.s11)))), 1 / denL);
  const rl = s12s21 / Math.abs(denL);
  const denS = s11 ** 2 - dm ** 2;
  const cs = scale(conj(sub(s.s11, mul(d, conj(s.s22)))), 1 / denS);
  const rs = s12s21 / Math.abs(denS);

  // Γ=0 is stable iff |S11|<1 (load plane) / |S22|<1 (source plane).
  const region = (center: Complex, r: number, originStable: boolean): "inside" | "outside" => {
    const originInside = abs(center) < r;
    return originInside === originStable ? "inside" : "outside";
  };
  return {
    delta: d,
    delta_magnitude: dm,
    k,
    mu_source: muSource,
    mu_load: muLoad,
    unconditionally_stable: muLoad > 1,
    load_circle: { center: cl, radius: rl, stable_region: region(cl, rl, s11 < 1) },
    source_circle: { center: cs, radius: rs, stable_region: region(cs, rs, s22 < 1) },
  };
}

// ---------------------------------------------------------------- gains

/** Γin = S11 + S12 S21 ΓL / (1 − S22 ΓL) */
export const gammaIn = (s: TwoPort, gl: Complex): Complex =>
  add(s.s11, div(mul(mul(s.s12, s.s21), gl), sub(ONE, mul(s.s22, gl))));
/** Γout = S22 + S12 S21 ΓS / (1 − S11 ΓS) */
export const gammaOut = (s: TwoPort, gs: Complex): Complex =>
  add(s.s22, div(mul(mul(s.s12, s.s21), gs), sub(ONE, mul(s.s11, gs))));

/** Transducer power gain G_T (linear) for given source/load reflection coefficients. */
export function transducerGain(s: TwoPort, gs: Complex, gl: Complex): number {
  const gin = gammaIn(s, gl);
  const num = (1 - abs2(gs)) * abs2(s.s21) * (1 - abs2(gl));
  const den = abs2(sub(ONE, mul(gs, gin))) * abs2(sub(ONE, mul(s.s22, gl)));
  return num / den;
}

export function availableGain(s: TwoPort, gs: Complex): number {
  const gout = gammaOut(s, gs);
  return ((1 - abs2(gs)) * abs2(s.s21)) / (abs2(sub(ONE, mul(s.s11, gs))) * (1 - abs2(gout)));
}

export function operatingGain(s: TwoPort, gl: Complex): number {
  const gin = gammaIn(s, gl);
  return (abs2(s.s21) * (1 - abs2(gl))) / ((1 - abs2(gin)) * abs2(sub(ONE, mul(s.s22, gl))));
}

export interface ConjugateMatch {
  feasible: boolean;
  reason?: string;
  gamma_source?: Complex;
  gamma_load?: Complex;
  z_source?: Complex;
  z_load?: Complex;
  gt_max_db?: number;
  msg_db: number;
  unilateral_figure_of_merit: number;
  unilateral_error_range_db: [number, number];
  gtu_max_db: number;
  k: number;
  delta_magnitude: number;
}

export function conjugateMatch(s: TwoPort, z0: number): ConjugateMatch {
  const st = stability(s);
  const d = st.delta;
  const s11 = abs(s.s11);
  const s22 = abs(s.s22);
  const s21 = abs(s.s21);
  const s12 = abs(s.s12);
  const msg = s12 === 0 ? Number.POSITIVE_INFINITY : s21 / s12;
  const u = (s12 * s21 * s11 * s22) / ((1 - s11 ** 2) * (1 - s22 ** 2));
  const gtu = s21 ** 2 / ((1 - s11 ** 2) * (1 - s22 ** 2));
  const base = {
    msg_db: 10 * Math.log10(msg),
    unilateral_figure_of_merit: u,
    unilateral_error_range_db: [10 * Math.log10(1 / (1 + u) ** 2), 10 * Math.log10(1 / (1 - u) ** 2)] as [
      number,
      number,
    ],
    gtu_max_db: 10 * Math.log10(gtu),
    k: st.k,
    delta_magnitude: st.delta_magnitude,
  };
  if (!(st.k > 1 && st.delta_magnitude < 1)) {
    return {
      feasible: false,
      reason: "Device is not unconditionally stable (requires K > 1 and |Δ| < 1); use MSG and gain circles instead",
      ...base,
    };
  }
  const solve = (b: number, cc: Complex): Complex => {
    const root = Math.sqrt(Math.max(0, b * b - 4 * abs2(cc)));
    const num = b > 0 ? b - root : b + root;
    return scale(div(ONE, cc), num / 2); // (B ∓ √(B²−4|C|²)) / (2C)
  };
  const b1 = 1 + s11 ** 2 - s22 ** 2 - st.delta_magnitude ** 2;
  const b2 = 1 + s22 ** 2 - s11 ** 2 - st.delta_magnitude ** 2;
  const c1 = sub(s.s11, mul(d, conj(s.s22)));
  const c2 = sub(s.s22, mul(d, conj(s.s11)));
  const gs = solve(b1, c1);
  const gl = solve(b2, c2);
  const gtMax = msg * (st.k - Math.sqrt(st.k ** 2 - 1));
  return {
    feasible: true,
    gamma_source: gs,
    gamma_load: gl,
    z_source: zFromGamma(gs, z0),
    z_load: zFromGamma(gl, z0),
    gt_max_db: 10 * Math.log10(gtMax),
    ...base,
  };
}

export type GainCircleType = "available" | "operating" | "unilateral_source" | "unilateral_load";

export interface GainCircle extends Circle {
  gain_db: number;
  plane: "source" | "load";
  achievable: boolean;
}

/**
 * Constant-gain circles (Pozar §12.3/12.4).
 * - available: source plane, G_A (bilateral)
 * - operating: load plane, G_P (bilateral)
 * - unilateral_source / unilateral_load: G_S / G_L contributions with S12 ≈ 0 (gain_db is the block gain, not total)
 */
export function gainCircle(s: TwoPort, type: GainCircleType, gainDb: number): GainCircle {
  const d = deltaOf(s);
  const dm2 = abs2(d);
  const s12s21 = abs(mul(s.s12, s.s21));
  const st = stability(s);
  if (type === "available" || type === "operating") {
    const g = fromDB10(gainDb) / abs2(s.s21);
    const [sa, cc] = type === "available" ? [s.s11, sub(s.s11, mul(d, conj(s.s22)))] : [s.s22, sub(s.s22, mul(d, conj(s.s11)))];
    const den = 1 + g * (abs2(sa) - dm2);
    const center = scale(conj(cc), g / den);
    const r2 = 1 - 2 * st.k * s12s21 * g + (s12s21 * g) ** 2;
    return {
      gain_db: gainDb,
      plane: type === "available" ? "source" : "load",
      center,
      radius: Math.sqrt(Math.max(0, r2)) / Math.abs(den),
      achievable: r2 >= 0,
    };
  }
  const sii = type === "unilateral_source" ? s.s11 : s.s22;
  const m2 = abs2(sii);
  const gMax = 1 / (1 - m2);
  const g = fromDB10(gainDb) / gMax; // normalised 0..1
  const den = 1 - (1 - g) * m2;
  return {
    gain_db: gainDb,
    plane: type === "unilateral_source" ? "source" : "load",
    center: scale(conj(sii), g / den),
    radius: (Math.sqrt(Math.max(0, 1 - g)) * (1 - m2)) / den,
    achievable: g <= 1 + 1e-12,
  };
}

/** Maximum G_S or G_L (dB) for the unilateral design (conjugate match of S11 / S22). */
export const unilateralMaxDb = (sii: Complex): number => 10 * Math.log10(1 / (1 - abs2(sii)));

export interface NoiseCircle extends Circle {
  nf_db: number;
  achievable: boolean;
}

export function noiseCircle(n: NoiseParams, z0: number, nfDb: number): NoiseCircle {
  const fmin = fromDB10(n.nf_min_db);
  const f = fromDB10(nfDb);
  const rnN = n.rn / z0;
  const N = ((f - fmin) / (4 * rnN)) * abs2(add(ONE, n.gamma_opt));
  const center = scale(n.gamma_opt, 1 / (N + 1));
  const r2 = N * (N + 1 - abs2(n.gamma_opt));
  return { nf_db: nfDb, center, radius: Math.sqrt(Math.max(0, r2)) / (N + 1), achievable: nfDb >= n.nf_min_db };
}

/** Noise figure (dB) for a given source reflection coefficient. */
export function noiseFigureAt(n: NoiseParams, z0: number, gs: Complex): number {
  const fmin = fromDB10(n.nf_min_db);
  const rnN = n.rn / z0;
  const f = fmin + (4 * rnN * abs2(sub(gs, n.gamma_opt))) / ((1 - abs2(gs)) * abs2(add(ONE, n.gamma_opt)));
  return 10 * Math.log10(f);
}

