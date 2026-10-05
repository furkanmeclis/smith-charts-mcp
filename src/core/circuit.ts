import {
  abs,
  add,
  type Complex,
  c,
  div,
  inv,
  isFiniteC,
  mul,
  scale,
  tanh,
} from "./complex.ts";
import { gammaFromZ, vswrFromGammaMag } from "./rf.ts";
import { type Length, SPEED_OF_LIGHT } from "./units.ts";

export type Placement = "series" | "shunt";

interface Base {
  label?: string;
  /** ± percentage applied to the component's main value(s) for tolerance analysis */
  tolerance_pct?: number;
}

export type Component =
  | (Base & { type: "inductor"; placement: Placement; l: number; q?: number; esr?: number })
  | (Base & { type: "capacitor"; placement: Placement; c: number; q?: number; esr?: number; esl?: number })
  | (Base & { type: "resistor"; placement: Placement; r: number; esl?: number })
  | (Base & {
      type: "rlc";
      placement: Placement;
      arrangement: "series" | "parallel";
      r?: number;
      l?: number;
      c?: number;
    })
  | (Base & {
      type: "impedance";
      placement: Placement;
      z?: Complex;
      table?: { f: number; z: Complex }[];
      interpolation?: "linear" | "hold";
    })
  | (Base & { type: "transmission_line"; z0: number; length: Length; eps_eff: number; loss_db_per_m: number })
  | (Base & {
      type: "stub";
      termination: "open" | "short";
      placement: Placement;
      z0: number;
      length: Length;
      eps_eff: number;
      loss_db_per_m: number;
    })
  | (Base & { type: "transformer"; turns_ratio: number })
  | (Base & { type: "coupled_inductors"; l_load: number; l_source: number; k: number });

/** Load impedance as a function of frequency. */
export type LoadFn = (f: number) => Complex;

const OPEN = c(Number.POSITIVE_INFINITY, 0);

export function tableLookup(table: { f: number; z: Complex }[], f: number, mode: "linear" | "hold"): Complex {
  const t = [...table].sort((a, b) => a.f - b.f);
  if (t.length === 0) return c(0);
  if (f <= t[0].f) return t[0].z;
  if (f >= t[t.length - 1].f) return t[t.length - 1].z;
  for (let i = 0; i < t.length - 1; i++) {
    if (f >= t[i].f && f < t[i + 1].f) {
      if (mode === "hold") return t[i].z;
      const u = (f - t[i].f) / (t[i + 1].f - t[i].f);
      return c(t[i].z.re + u * (t[i + 1].z.re - t[i].z.re), t[i].z.im + u * (t[i + 1].z.im - t[i].z.im));
    }
  }
  return t[t.length - 1].z;
}

export const lengthMeters = (len: Length, f0: number, epsEff: number): number =>
  len.kind === "physical" ? len.meters : (len.wavelengths * SPEED_OF_LIGHT) / (f0 * Math.sqrt(epsEff));

/** γℓ for a line of physical length ℓ at frequency f. */
function gammaL(meters: number, f: number, epsEff: number, lossDbPerM: number): Complex {
  const beta = (2 * Math.PI * f * Math.sqrt(epsEff)) / SPEED_OF_LIGHT;
  const alpha = lossDbPerM / (20 / Math.LN10); // dB → Np
  return c(alpha * meters, beta * meters);
}

/** Impedance of a 2-terminal lumped element (used for series insertion or shunt to ground). */
function elementZ(comp: Component, f: number, k: number): Complex {
  const w = 2 * Math.PI * f;
  switch (comp.type) {
    case "inductor": {
      const xl = w * comp.l * k;
      const r = (comp.esr ?? 0) + (comp.q ? xl / comp.q : 0);
      return c(r, xl);
    }
    case "capacitor": {
      const xc = -1 / (w * comp.c * k);
      const r = (comp.esr ?? 0) + (comp.q ? Math.abs(xc) / comp.q : 0);
      return c(r, xc + w * (comp.esl ?? 0));
    }
    case "resistor":
      return c(comp.r * k, w * (comp.esl ?? 0));
    case "rlc": {
      const parts: Complex[] = [];
      if (comp.r !== undefined) parts.push(c(comp.r * k));
      if (comp.l !== undefined) parts.push(c(0, w * comp.l * k));
      if (comp.c !== undefined) parts.push(c(0, -1 / (w * comp.c * k)));
      if (comp.arrangement === "series") return parts.reduce(add, c(0));
      return inv(parts.map(inv).reduce(add, c(0)));
    }
    case "impedance": {
      const z = comp.table ? tableLookup(comp.table, f, comp.interpolation ?? "linear") : (comp.z ?? c(0));
      return scale(z, k);
    }
    default:
      throw new Error(`elementZ: ${comp.type} is not a lumped element`);
  }
}

function tlineInput(zl: Complex, z0: number, gl: Complex): Complex {
  const th = tanh(gl);
  if (!isFiniteC(zl)) return scale(inv(th), z0); // open: Z0 coth(γℓ)
  return scale(div(add(zl, scale(th, z0)), add(c(z0), mul(zl, th))), z0);
}

const seriesAdd = (zPrev: Complex, z: Complex): Complex => (isFiniteC(zPrev) ? add(zPrev, z) : OPEN);
const shuntAdd = (zPrev: Complex, z: Complex): Complex => inv(add(inv(zPrev), inv(z)));

/**
 * Impedance looking into `comp` (towards the load) when the load side presents zPrev.
 * `t` ∈ [0,1] scales the element "amount" from nothing to its full value — used to draw arcs.
 * `k` is the tolerance multiplier on the component's main value.
 */
export function applyComponent(zPrev: Complex, comp: Component, f: number, f0: number, t = 1, k = 1): Complex {
  switch (comp.type) {
    case "inductor":
    case "capacitor":
    case "resistor":
    case "rlc":
    case "impedance": {
      const ze = elementZ(comp, f, k);
      if (comp.placement === "series") return seriesAdd(zPrev, scale(ze, t));
      return t === 0 ? zPrev : shuntAdd(zPrev, scale(ze, 1 / t)); // admittance scales with t
    }
    case "transmission_line": {
      const m = lengthMeters(comp.length, f0, comp.eps_eff) * k * t;
      return tlineInput(zPrev, comp.z0, gammaL(m, f, comp.eps_eff, comp.loss_db_per_m));
    }
    case "stub": {
      const m = lengthMeters(comp.length, f0, comp.eps_eff) * k * t;
      const gl = gammaL(m, f, comp.eps_eff, comp.loss_db_per_m);
      const zs = comp.termination === "short" ? scale(tanh(gl), comp.z0) : scale(inv(tanh(gl)), comp.z0);
      return comp.placement === "series" ? seriesAdd(zPrev, zs) : shuntAdd(zPrev, zs);
    }
    case "transformer": {
      const n2 = comp.turns_ratio ** 2;
      return scale(zPrev, 1 + (n2 - 1) * t);
    }
    case "coupled_inductors": {
      // T-equivalent: series (L_load − M), shunt M, series (L_source − M)
      const w = 2 * Math.PI * f;
      const m = comp.k * Math.sqrt(comp.l_load * comp.l_source);
      let z = seriesAdd(zPrev, c(0, w * (comp.l_load - m) * t));
      z = t === 0 ? z : shuntAdd(z, c(0, (w * m) / t));
      return seriesAdd(z, c(0, w * (comp.l_source - m) * t));
    }
  }
}

/** Node impedances: [load, after component 1, …, input]. Components are ordered load → source. */
export function cascade(load: Complex, comps: Component[], f: number, f0: number, factors?: number[]): Complex[] {
  const nodes = [load];
  let z = load;
  comps.forEach((comp, i) => {
    z = applyComponent(z, comp, f, f0, 1, factors?.[i] ?? 1);
    nodes.push(z);
  });
  return nodes;
}

export const inputImpedance = (load: Complex, comps: Component[], f: number, f0: number, factors?: number[]): Complex => {
  const n = cascade(load, comps, f, f0, factors);
  return n[n.length - 1];
};

/** Γ-plane trajectory drawn by each component as its value grows from 0 to full. */
export function componentArcs(load: Complex, comps: Component[], f: number, f0: number, z0: number, steps = 60): Complex[][] {
  const arcs: Complex[][] = [];
  let z = load;
  for (const comp of comps) {
    const pts: Complex[] = [];
    // long lines: sample proportionally so multiple turns stay smooth
    let n = steps;
    if (comp.type === "transmission_line" || comp.type === "stub") {
      const wl = (lengthMeters(comp.length, f0, comp.eps_eff) * f * Math.sqrt(comp.eps_eff)) / SPEED_OF_LIGHT;
      n = Math.min(4000, Math.max(steps, Math.ceil(wl * 2 * steps)));
    }
    for (let i = 0; i <= n; i++) pts.push(gammaFromZ(applyComponent(z, comp, f, f0, i / n), z0));
    arcs.push(pts);
    z = applyComponent(z, comp, f, f0);
  }
  return arcs;
}

export interface SweepSpec {
  start: number;
  stop: number;
  points: number;
  scale: "linear" | "log";
}

export function sweepFrequencies(s: SweepSpec): number[] {
  const n = Math.max(2, Math.min(2001, Math.round(s.points)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    out.push(
      s.scale === "log" && s.start > 0 ? s.start * (s.stop / s.start) ** u : s.start + (s.stop - s.start) * u,
    );
  }
  return out;
}

export interface BandResult {
  threshold_vswr: number;
  lower_hz: number | null;
  upper_hz: number | null;
  bandwidth_hz: number | null;
  fractional_pct: number | null;
  /** True when the band edge hit the search limit (band may be wider) */
  limited: boolean;
}

/**
 * Contiguous band around f0 where VSWR ≤ threshold, found by stepping out
 * from f0 and refining each edge with bisection.
 */
export function matchedBandwidth(
  vswrAt: (f: number) => number,
  f0: number,
  thresholdVswr: number,
  searchFactor = 0.95,
): BandResult {
  const empty = {
    threshold_vswr: thresholdVswr,
    lower_hz: null,
    upper_hz: null,
    bandwidth_hz: null,
    fractional_pct: null,
    limited: false,
  };
  if (!(vswrAt(f0) <= thresholdVswr)) return empty;
  let limited = false;
  const edge = (dir: 1 | -1): number => {
    const limit = f0 * (1 + dir * searchFactor);
    const steps = 400;
    let inside = f0;
    for (let i = 1; i <= steps; i++) {
      const f = f0 + ((limit - f0) * i) / steps;
      if (vswrAt(f) <= thresholdVswr) inside = f;
      else {
        let lo = inside;
        let hi = f;
        for (let j = 0; j < 50; j++) {
          const mid = (lo + hi) / 2;
          if (vswrAt(mid) <= thresholdVswr) lo = mid;
          else hi = mid;
        }
        return lo;
      }
    }
    limited = true;
    return limit;
  };
  const lower = edge(-1);
  const upper = edge(1);
  return {
    threshold_vswr: thresholdVswr,
    lower_hz: lower,
    upper_hz: upper,
    bandwidth_hz: upper - lower,
    fractional_pct: ((upper - lower) / f0) * 100,
    limited,
  };
}

export function vswrOf(z: Complex, z0: number): number {
  return vswrFromGammaMag(abs(gammaFromZ(z, z0)));
}

/** Enumerates tolerance corners (all ± combinations up to 2^10, otherwise random corners). */
export function toleranceCorners(comps: Component[], maxCorners = 1024): number[][] {
  const idx = comps.map((cmp, i) => ((cmp.tolerance_pct ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return [];
  const corners: number[][] = [];
  const make = (bits: (i: number) => boolean) => {
    const f = comps.map(() => 1);
    idx.forEach((ci, j) => {
      const tol = (comps[ci].tolerance_pct ?? 0) / 100;
      f[ci] = bits(j) ? 1 + tol : 1 - tol;
    });
    return f;
  };
  if (idx.length <= 10) {
    for (let m = 0; m < 2 ** idx.length && corners.length < maxCorners; m++) corners.push(make((j) => ((m >> j) & 1) === 1));
  } else {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let m = 0; m < maxCorners; m++) corners.push(make(() => rnd() < 0.5));
  }
  return corners;
}

