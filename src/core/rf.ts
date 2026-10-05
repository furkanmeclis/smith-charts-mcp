import {
  abs,
  add,
  argDeg,
  type Complex,
  c,
  div,
  inv,
  isFiniteC,
  ONE,
  round,
  roundC,
  scale,
  sub,
} from "./complex.ts";

/** Γ = (Z − Z0) / (Z + Z0). An infinite Z (open) maps to Γ = 1. */
export function gammaFromZ(z: Complex, z0: number): Complex {
  if (!isFiniteC(z)) return ONE;
  return div(sub(z, c(z0)), add(z, c(z0)));
}

/** Z = Z0 (1 + Γ) / (1 − Γ). Γ = 1 maps to an infinite (open) impedance. */
export function zFromGamma(gamma: Complex, z0: number): Complex {
  return scale(div(add(ONE, gamma), sub(ONE, gamma)), z0);
}

export function vswrFromGammaMag(g: number): number {
  return g >= 1 ? Number.POSITIVE_INFINITY : (1 + g) / (1 - g);
}

export const dB10 = (x: number): number => 10 * Math.log10(x);
export const dB20 = (x: number): number => 20 * Math.log10(x);
export const fromDB10 = (db: number): number => 10 ** (db / 10);

export interface ImpedanceMetrics {
  z: Complex;
  z_normalized: Complex;
  y: Complex;
  y_normalized: Complex;
  gamma: Complex;
  gamma_magnitude: number;
  gamma_angle_deg: number;
  vswr: number;
  return_loss_db: number;
  mismatch_loss_db: number;
  power_delivered_pct: number;
  q: number;
  equivalent: { series: string; parallel: string };
}

/** Full single-point characterisation of an impedance against a real reference Z0. */
export function impedanceMetrics(z: Complex, z0: number): ImpedanceMetrics {
  const gamma = gammaFromZ(z, z0);
  const g = abs(gamma);
  const y = inv(z);
  const delivered = Math.max(0, 1 - g * g);
  return {
    z: roundC(z),
    z_normalized: roundC(scale(z, 1 / z0)),
    y: roundC(y),
    y_normalized: roundC(scale(y, z0)),
    gamma: roundC(gamma),
    gamma_magnitude: round(g),
    gamma_angle_deg: round(argDeg(gamma)),
    vswr: round(vswrFromGammaMag(g)),
    return_loss_db: round(g === 0 ? Number.POSITIVE_INFINITY : -dB20(g)),
    mismatch_loss_db: round(delivered === 0 ? Number.POSITIVE_INFINITY : -dB10(delivered)),
    power_delivered_pct: round(delivered * 100),
    q: round(z.re === 0 ? Number.POSITIVE_INFINITY : Math.abs(z.im / z.re)),
    equivalent: { series: describeSeries(z), parallel: describeParallel(y) },
  };
}

function describeSeries(z: Complex): string {
  if (!isFiniteC(z)) return "open";
  return `R=${round(z.re, 4)} Ω in series with X=${round(z.im, 4)} Ω`;
}

function describeParallel(y: Complex): string {
  if (y.re === 0 && y.im === 0) return "open";
  const rp = y.re === 0 ? Number.POSITIVE_INFINITY : 1 / y.re;
  const xp = y.im === 0 ? Number.POSITIVE_INFINITY : -1 / y.im;
  return `Rp=${round(rp, 4)} Ω in parallel with Xp=${round(xp, 4)} Ω`;
}

/** Reactance X (Ω) at angular frequency ω → equivalent L or C. */
export function reactanceToElement(x: number, omega: number): { kind: "inductor" | "capacitor"; value: number } | null {
  if (x === 0 || !Number.isFinite(x)) return null;
  return x > 0 ? { kind: "inductor", value: x / omega } : { kind: "capacitor", value: -1 / (omega * x) };
}

/** Susceptance B (S) at ω → equivalent shunt L or C. */
export function susceptanceToElement(b: number, omega: number): { kind: "inductor" | "capacitor"; value: number } | null {
  if (b === 0 || !Number.isFinite(b)) return null;
  return b > 0 ? { kind: "capacitor", value: b / omega } : { kind: "inductor", value: -1 / (omega * b) };
}
