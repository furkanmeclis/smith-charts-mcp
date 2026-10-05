import { abs, argDeg, type Complex, c, conj, inv } from "./complex.ts";
import { type Component, inputImpedance, matchedBandwidth, vswrOf, type BandResult } from "./circuit.ts";
import { gammaFromZ } from "./rf.ts";
import { formatSI } from "./units.ts";

/** Ideal reactive element before conversion to an L or C at a given frequency. */
export interface RawElement {
  placement: "series" | "shunt";
  /** reactance Ω for series elements, susceptance S for shunt elements */
  value: number;
}

const EPS = 1e-9;

/**
 * All L-section solutions transforming `zl` into `target` (the impedance the network must present,
 * i.e. conj(Zsource) for a conjugate match). Elements are ordered load → source.
 */
export function lMatchRaw(zl: Complex, target: Complex): { topology: "shunt_series" | "series_shunt"; elements: RawElement[] }[] {
  const out: { topology: "shunt_series" | "series_shunt"; elements: RawElement[] }[] = [];
  const yl = inv(zl);
  const yt = inv(target);
  const rt = target.re;
  const gt = yt.re;

  // shunt element at the load, series element towards the source
  if (yl.re > 0 && rt > 0 && rt * yl.re <= 1 + EPS) {
    const root = Math.sqrt(Math.max(0, yl.re / rt - yl.re ** 2));
    for (const bp of uniq([root, -root])) {
      const z1 = inv(c(yl.re, bp));
      out.push({
        topology: "shunt_series",
        elements: [
          { placement: "shunt", value: bp - yl.im },
          { placement: "series", value: target.im - z1.im },
        ],
      });
    }
  }
  // series element at the load, shunt element towards the source
  if (zl.re > 0 && gt > 0 && zl.re * gt <= 1 + EPS) {
    const root = Math.sqrt(Math.max(0, zl.re / gt - zl.re ** 2));
    for (const xp of uniq([root, -root])) {
      const y1 = inv(c(zl.re, xp));
      out.push({
        topology: "series_shunt",
        elements: [
          { placement: "series", value: xp - zl.im },
          { placement: "shunt", value: yt.im - y1.im },
        ],
      });
    }
  }
  return out;
}

function uniq(xs: number[]): number[] {
  return xs.filter((x, i) => xs.findIndex((y) => Math.abs(x - y) <= EPS * Math.max(1, Math.abs(x))) === i);
}

/** Converts ideal reactances into inductors/capacitors at frequency f. Near-zero elements are dropped. */
export function rawToComponents(elements: RawElement[], f: number, scaleRef: number): Component[] {
  const w = 2 * Math.PI * f;
  const comps: Component[] = [];
  for (const e of elements) {
    // ignore elements that are negligible relative to the impedance level
    const negligible = e.placement === "series" ? Math.abs(e.value) < 1e-6 * scaleRef : Math.abs(e.value) * scaleRef < 1e-6;
    if (negligible || !Number.isFinite(e.value)) continue;
    if (e.placement === "series") {
      comps.push(
        e.value > 0
          ? { type: "inductor", placement: "series", l: e.value / w }
          : { type: "capacitor", placement: "series", c: -1 / (w * e.value) },
      );
    } else {
      comps.push(
        e.value > 0
          ? { type: "capacitor", placement: "shunt", c: e.value / w }
          : { type: "inductor", placement: "shunt", l: -1 / (w * e.value) },
      );
    }
  }
  return comps;
}

export function describeComponents(comps: Component[]): string {
  if (comps.length === 0) return "no components (already matched)";
  return comps
    .map((cmp) => {
      if (cmp.type === "inductor") return `${cmp.placement} L ${formatSI(cmp.l, "H")}`;
      if (cmp.type === "capacitor") return `${cmp.placement} C ${formatSI(cmp.c, "F")}`;
      if (cmp.type === "transmission_line")
        return `line Z0=${cmp.z0} Ω, ${cmp.length.kind === "electrical" ? `${round4(cmp.length.wavelengths)}λ` : formatSI(cmp.length.meters, "m")}`;
      if (cmp.type === "stub")
        return `${cmp.termination}-circuit ${cmp.placement} stub Z0=${cmp.z0} Ω, ${cmp.length.kind === "electrical" ? `${round4(cmp.length.wavelengths)}λ` : formatSI(cmp.length.meters, "m")}`;
      return cmp.type;
    })
    .join(" → ");
}

const round4 = (x: number) => Number.parseFloat(x.toPrecision(4));

/** low-pass / high-pass / band-pass classification of a lumped ladder. */
export function responseType(comps: Component[]): "lowpass" | "highpass" | "bandpass" | "none" {
  if (comps.length === 0) return "none";
  const lp = comps.every(
    (x) => (x.type === "inductor" && x.placement === "series") || (x.type === "capacitor" && x.placement === "shunt"),
  );
  const hp = comps.every(
    (x) => (x.type === "capacitor" && x.placement === "series") || (x.type === "inductor" && x.placement === "shunt"),
  );
  return lp ? "lowpass" : hp ? "highpass" : "bandpass";
}

/** DC passes from source to load when no series capacitor exists; a shunt inductor shorts DC to ground. */
export function dcBehaviour(comps: Component[]): { dc_block: boolean; dc_short_to_ground: boolean } {
  return {
    dc_block: comps.some((x) => x.type === "capacitor" && x.placement === "series"),
    dc_short_to_ground: comps.some((x) => x.type === "inductor" && x.placement === "shunt"),
  };
}

// ---------------------------------------------------------------- E-series

const E_BASE: Record<"E6" | "E12" | "E24", number[]> = {
  E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [
    1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2,
    9.1,
  ],
};

export type ESeries = "E6" | "E12" | "E24" | "E48" | "E96";

function seriesValues(series: ESeries): number[] {
  if (series in E_BASE) return E_BASE[series as keyof typeof E_BASE];
  const n = series === "E48" ? 48 : 96;
  return Array.from({ length: n }, (_, i) => Number.parseFloat((10 ** (i / n)).toPrecision(3)));
}

export function snapToSeries(value: number, series: ESeries): number {
  if (!(value > 0)) return value;
  const dec = Math.floor(Math.log10(value));
  let best = value;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const d of [dec - 1, dec, dec + 1]) {
    for (const b of seriesValues(series)) {
      const v = b * 10 ** d;
      const err = Math.abs(Math.log(v / value));
      if (err < bestErr) {
        bestErr = err;
        best = Number.parseFloat(v.toPrecision(3));
      }
    }
  }
  return best;
}

export function snapComponents(comps: Component[], series: ESeries): Component[] {
  return comps.map((x) => {
    if (x.type === "inductor") return { ...x, l: snapToSeries(x.l, series) };
    if (x.type === "capacitor") return { ...x, c: snapToSeries(x.c, series) };
    if (x.type === "resistor") return { ...x, r: snapToSeries(x.r, series) };
    return x;
  });
}

// ---------------------------------------------------------------- verification

export interface Verification {
  z_in: Complex;
  vswr: number;
  return_loss_db: number;
  bandwidth?: BandResult;
}

export function verify(
  zl: Complex | ((f: number) => Complex),
  comps: Component[],
  zs: Complex,
  f0: number,
  bwVswr?: number,
): Verification {
  const loadAt = typeof zl === "function" ? zl : () => zl;
  // mismatch between the network input and the source is measured against conj(Zs) (power-wave Γ)
  const gammaAt = (f: number) => {
    const zin = inputImpedance(loadAt(f), comps, f, f0);
    return powerWaveGamma(zin, zs);
  };
  const g = gammaAt(f0);
  const vs = (gm: number) => (gm >= 1 ? Number.POSITIVE_INFINITY : (1 + gm) / (1 - gm));
  return {
    z_in: inputImpedance(loadAt(f0), comps, f0, f0),
    vswr: vs(g),
    return_loss_db: g === 0 ? Number.POSITIVE_INFINITY : -20 * Math.log10(g),
    bandwidth: bwVswr ? matchedBandwidth((f) => vs(gammaAt(f)), f0, bwVswr) : undefined,
  };
}

/** |Γ| = |Zin − Zs*| / |Zin + Zs| — equals the usual Γ when Zs is real. */
export function powerWaveGamma(zin: Complex, zs: Complex): number {
  const num = c(zin.re - zs.re, zin.im + zs.im);
  const den = c(zin.re + zs.re, zin.im + zs.im);
  return abs(num) / abs(den);
}

// ---------------------------------------------------------------- Pi / T

export function piTMatchRaw(
  zl: Complex,
  zs: Complex,
  q: number,
  kind: "pi" | "t",
): { elements: RawElement[]; virtual_resistance: number } [] | { error: string; min_q: number } {
  const rl = zl.re;
  const rs = zs.re;
  const rHigh = Math.max(rl, rs);
  const rLow = Math.min(rl, rs);
  const minQ = Math.sqrt(Math.max(0, rHigh / rLow - 1));
  if (q <= minQ) return { error: `Q must exceed √(Rhigh/Rlow − 1) = ${minQ.toPrecision(4)}`, min_q: minQ };
  const rv = kind === "pi" ? rHigh / (q * q + 1) : rLow * (q * q + 1);
  const target = conj(zs);
  const sols: { elements: RawElement[]; virtual_resistance: number }[] = [];
  const s1 = lMatchRaw(zl, c(rv)).filter((s) => s.topology === (kind === "pi" ? "shunt_series" : "series_shunt"));
  const s2 = lMatchRaw(c(rv), target).filter((s) => s.topology === (kind === "pi" ? "series_shunt" : "shunt_series"));
  for (const a of s1) {
    for (const b of s2) {
      // merge the two middle elements of the same placement
      const mid: RawElement = { placement: a.elements[1].placement, value: a.elements[1].value + b.elements[0].value };
      sols.push({ elements: [a.elements[0], mid, b.elements[1]], virtual_resistance: rv });
    }
  }
  return sols;
}

// ---------------------------------------------------------------- stubs

export interface StubSolution {
  distance_wavelengths: number;
  stub_length_wavelengths: number;
  termination: "open" | "short";
  placement: "shunt" | "series";
}

const mod05 = (x: number) => ((x % 0.5) + 0.5) % 0.5;

/** Single-stub match (Pozar §5.2). Distances are measured from the load towards the source. */
export function singleStubRaw(
  zl: Complex,
  z0: number,
  stubZ0: number,
  placement: "shunt" | "series",
): StubSolution[] {
  // series case is the dual of shunt: swap Z ↔ Y
  const L = placement === "shunt" ? zl : inv(zl);
  const R0 = placement === "shunt" ? z0 : 1 / z0;
  const rl = L.re;
  const xl = L.im;
  if (!(rl > 0)) return [];
  const ts: number[] = [];
  if (Math.abs(rl - R0) < 1e-12 * R0) ts.push(-xl / (2 * R0));
  else {
    const root = Math.sqrt((rl * ((R0 - rl) ** 2 + xl ** 2)) / R0);
    ts.push((xl + root) / (rl - R0), (xl - root) / (rl - R0));
  }
  const sols: StubSolution[] = [];
  for (const t of ts) {
    const d = t >= 0 ? Math.atan(t) / (2 * Math.PI) : (Math.PI + Math.atan(t)) / (2 * Math.PI);
    // B (shunt) or X (series) seen at distance d
    const b = (rl ** 2 * t - (R0 - xl * t) * (xl + R0 * t)) / (R0 * (rl ** 2 + (xl + R0 * t) ** 2));
    const s0 = placement === "shunt" ? 1 / stubZ0 : stubZ0; // Y0 of stub (shunt) or Z0 of stub (series)
    // shunt: open → jY0 tanβl = −jB ; short → −jY0 cotβl = −jB
    // series: open → −jZ0 cotβl = −jX ; short → jZ0 tanβl = −jX
    const open = placement === "shunt" ? Math.atan(-b / s0) : Math.atan(s0 / b);
    const short = placement === "shunt" ? Math.atan(s0 / b) : Math.atan(-b / s0);
    sols.push({
      distance_wavelengths: mod05(d),
      stub_length_wavelengths: mod05(open / (2 * Math.PI)),
      termination: "open",
      placement,
    });
    sols.push({
      distance_wavelengths: mod05(d),
      stub_length_wavelengths: mod05(short / (2 * Math.PI)),
      termination: "short",
      placement,
    });
  }
  return sols;
}

// ---------------------------------------------------------------- quarter-wave

export interface QuarterWaveOption {
  /** line section (reference Z0) inserted between load and transformer, wavelengths */
  offset_wavelengths: number;
  /** real impedance at the transformer's load end */
  r_at_transformer: number;
  transformer_z0: number;
  point: "load_is_real" | "voltage_maximum" | "voltage_minimum";
}

export function quarterWaveOptions(zl: Complex, z0: number): QuarterWaveOption[] {
  const g = gammaFromZ(zl, z0);
  const gm = abs(g);
  if (Math.abs(zl.im) < 1e-9 * Math.max(1, abs(zl)) && zl.re > 0) {
    return [{ offset_wavelengths: 0, r_at_transformer: zl.re, transformer_z0: Math.sqrt(z0 * zl.re), point: "load_is_real" }];
  }
  if (gm >= 1) return [];
  const phi = ((argDeg(g) % 360) + 360) % 360; // degrees
  const vswr = (1 + gm) / (1 - gm);
  const rMax = z0 * vswr;
  const rMin = z0 / vswr;
  return [
    {
      offset_wavelengths: mod05(phi / 720),
      r_at_transformer: rMax,
      transformer_z0: Math.sqrt(z0 * rMax),
      point: "voltage_maximum",
    },
    {
      offset_wavelengths: mod05((phi - 180) / 720),
      r_at_transformer: rMin,
      transformer_z0: Math.sqrt(z0 * rMin),
      point: "voltage_minimum",
    },
  ];
}

export { vswrOf };
