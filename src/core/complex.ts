/** Minimal immutable complex-number helpers (rectangular form). */
export interface Complex {
  re: number;
  im: number;
}

export const c = (re: number, im = 0): Complex => ({ re, im });

export const ZERO = c(0, 0);
export const ONE = c(1, 0);

export const add = (a: Complex, b: Complex): Complex => c(a.re + b.re, a.im + b.im);
export const sub = (a: Complex, b: Complex): Complex => c(a.re - b.re, a.im - b.im);
export const mul = (a: Complex, b: Complex): Complex => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const scale = (a: Complex, k: number): Complex => c(a.re * k, a.im * k);
export const conj = (a: Complex): Complex => c(a.re, -a.im);
export const abs = (a: Complex): number => Math.hypot(a.re, a.im);
export const abs2 = (a: Complex): number => a.re * a.re + a.im * a.im;
export const argDeg = (a: Complex): number => (Math.atan2(a.im, a.re) * 180) / Math.PI;

export function div(a: Complex, b: Complex): Complex {
  const d = abs2(b);
  if (d === 0) return c(a.re === 0 && a.im === 0 ? Number.NaN : Number.POSITIVE_INFINITY, 0);
  if (!Number.isFinite(d)) return isFiniteC(a) ? ZERO : c(Number.NaN, 0);
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}

export const inv = (a: Complex): Complex => div(ONE, a);

export function sqrt(a: Complex): Complex {
  const r = abs(a);
  const re = Math.sqrt((r + a.re) / 2);
  const im = Math.sign(a.im || 1) * Math.sqrt(Math.max(0, (r - a.re) / 2));
  return c(re, im);
}

export function exp(a: Complex): Complex {
  const e = Math.exp(a.re);
  return c(e * Math.cos(a.im), e * Math.sin(a.im));
}

/** tanh(z) = (1 - e^{-2z}) / (1 + e^{-2z}), stable for large Re(z). */
export function tanh(a: Complex): Complex {
  const e = exp(scale(a, -2));
  return div(sub(ONE, e), add(ONE, e));
}

export function fromPolar(mag: number, angleDeg: number): Complex {
  const t = (angleDeg * Math.PI) / 180;
  return c(mag * Math.cos(t), mag * Math.sin(t));
}

export const isFiniteC = (a: Complex): boolean => Number.isFinite(a.re) && Number.isFinite(a.im);

/** Parallel combination a || b. */
export const parallel = (a: Complex, b: Complex): Complex => inv(add(inv(a), inv(b)));

export function round(x: number, digits = 6): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  return Number.parseFloat(x.toPrecision(digits));
}

export const roundC = (a: Complex, digits = 6): Complex => c(round(a.re, digits), round(a.im, digits));

export function format(a: Complex, digits = 4): string {
  if (!isFiniteC(a)) return "∞";
  const re = round(a.re, digits);
  const im = round(a.im, digits);
  return `${re} ${im < 0 ? "-" : "+"} j${Math.abs(im)}`;
}

export function formatPolar(a: Complex, digits = 4): string {
  return `${round(abs(a), digits)} ∠ ${round(argDeg(a), digits)}°`;
}
