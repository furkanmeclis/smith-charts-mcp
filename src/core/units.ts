/**
 * Engineering-notation quantity parsing.
 * Bare numbers are SI base units (Hz, H, F, Ω, m). Strings may carry an SI prefix
 * and an optional unit symbol: "2.4GHz", "2.4 G", "10nH", "1.5p", "4k7", "50 ohm".
 */

export type QuantityKind = "frequency" | "inductance" | "capacitance" | "resistance";

const PREFIX: Record<string, number> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  meg: 1e6,
  Meg: 1e6,
  MEG: 1e6,
  G: 1e9,
  T: 1e12,
};

const BASE_UNITS: Record<QuantityKind, string[]> = {
  frequency: ["hz"],
  inductance: ["henry", "henries", "h"],
  capacitance: ["farad", "farads", "f"],
  resistance: ["ohms", "ohm", "Ω", "r"],
};

export class UnitError extends Error {}

/** "4k7" → "4.7k" (resistor-style notation). */
function expandInfixPrefix(s: string): string {
  const m = s.match(/^(\d+)([pnuµμmkKMGRr])(\d+)$/);
  if (!m) return s;
  const prefix = m[2] === "R" || m[2] === "r" ? "" : m[2];
  return `${m[1]}.${m[3]}${prefix}`;
}

export function parseQuantity(input: number | string, kind: QuantityKind): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new UnitError(`Invalid ${kind}: ${input}`);
    return input;
  }
  const raw = expandInfixPrefix(input.trim().replace(/\s+/g, ""));
  const m = raw.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(.*)$/);
  if (!m) throw new UnitError(`Cannot parse ${kind} "${input}"`);
  const value = Number.parseFloat(m[1]);
  let rest = m[2];

  // strip base unit symbol (case-insensitive)
  for (const base of BASE_UNITS[kind]) {
    if (rest.toLowerCase().endsWith(base.toLowerCase()) && rest.length >= base.length) {
      const candidate = rest.slice(0, rest.length - base.length);
      if (candidate in PREFIX || (kind === "frequency" && candidate.toLowerCase() in lowerFreqPrefix)) {
        rest = candidate;
        break;
      }
    }
  }

  let mult: number | undefined;
  if (kind === "frequency") {
    // nobody means milli-hertz: "mhz", "MHz", "mHz" all mean MHz
    mult = lowerFreqPrefix[rest.toLowerCase()];
  } else {
    mult = PREFIX[rest];
  }
  if (mult === undefined) throw new UnitError(`Unknown unit/prefix "${m[2]}" for ${kind} in "${input}"`);
  return value * mult;
}

const lowerFreqPrefix: Record<string, number> = {
  "": 1,
  k: 1e3,
  m: 1e6,
  meg: 1e6,
  g: 1e9,
  t: 1e12,
};

export type Length = { kind: "physical"; meters: number } | { kind: "electrical"; wavelengths: number };

const LENGTH_UNITS: Record<string, [Length["kind"], number]> = {
  m: ["physical", 1],
  cm: ["physical", 1e-2],
  mm: ["physical", 1e-3],
  um: ["physical", 1e-6],
  µm: ["physical", 1e-6],
  μm: ["physical", 1e-6],
  mil: ["physical", 25.4e-6],
  mils: ["physical", 25.4e-6],
  in: ["physical", 25.4e-3],
  inch: ["physical", 25.4e-3],
  ft: ["physical", 0.3048],
  λ: ["electrical", 1],
  l: ["electrical", 1],
  lambda: ["electrical", 1],
  wl: ["electrical", 1],
  wavelength: ["electrical", 1],
  wavelengths: ["electrical", 1],
  deg: ["electrical", 1 / 360],
  "°": ["electrical", 1 / 360],
  degree: ["electrical", 1 / 360],
  degrees: ["electrical", 1 / 360],
  rad: ["electrical", 1 / (2 * Math.PI)],
};

/** Parses "0.125λ", "45deg", "12.3mm", "0.25 lambda". Bare numbers are meters. */
export function parseLength(input: number | string): Length {
  if (typeof input === "number") return { kind: "physical", meters: input };
  const raw = input.trim().replace(/\s+/g, "");
  const m = raw.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(.*)$/);
  if (!m) throw new UnitError(`Cannot parse length "${input}"`);
  const value = Number.parseFloat(m[1]);
  const unit = m[2] === "" ? "m" : m[2];
  const entry = LENGTH_UNITS[unit] ?? LENGTH_UNITS[unit.toLowerCase()];
  if (!entry) throw new UnitError(`Unknown length unit "${unit}" (use m, mm, cm, um, mil, in, λ, deg)`);
  return entry[0] === "physical"
    ? { kind: "physical", meters: value * entry[1] }
    : { kind: "electrical", wavelengths: value * entry[1] };
}

export const SPEED_OF_LIGHT = 299_792_458;

/** Engineering formatting: 2.4e9, "Hz" → "2.4 GHz". */
export function formatSI(value: number, unit: string, digits = 4): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  const prefixes: [number, string][] = [
    [1e12, "T"],
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"],
  ];
  const a = Math.abs(value);
  for (const [scale, p] of prefixes) {
    if (a >= scale * 0.9995) return `${Number.parseFloat((value / scale).toPrecision(digits))} ${p}${unit}`;
  }
  return `${value.toExponential(digits - 1)} ${unit}`;
}
