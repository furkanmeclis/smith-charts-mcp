import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputImpedance, sweepFrequencies } from "../src/core/circuit.ts";
import { abs, c, fromPolar } from "../src/core/complex.ts";
import {
  lMatchRaw,
  piTMatchRaw,
  powerWaveGamma,
  quarterWaveOptions,
  rawToComponents,
  singleStubRaw,
  snapToSeries,
} from "../src/core/matching.ts";
import { gammaFromZ, impedanceMetrics, zFromGamma } from "../src/core/rf.ts";
import {
  availableGain,
  conjugateMatch,
  gammaIn,
  gammaOut,
  gainCircle,
  noiseCircle,
  noiseFigureAt,
  operatingGain,
  parseTouchstone,
  stability,
  transducerGain,
  type TwoPort,
} from "../src/core/sparams.ts";
import { parseLength, parseQuantity } from "../src/core/units.ts";

const near = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

describe("units", () => {
  it("parses engineering notation", () => {
    near(parseQuantity("2.4GHz", "frequency"), 2.4e9);
    near(parseQuantity("915 mhz", "frequency"), 915e6);
    near(parseQuantity("10nH", "inductance"), 10e-9);
    near(parseQuantity("1.5p", "capacitance"), 1.5e-12);
    near(parseQuantity("4k7", "resistance"), 4700);
    near(parseQuantity("50 ohm", "resistance"), 50);
    near(parseQuantity("2.2uF", "capacitance"), 2.2e-6);
    near(parseQuantity(1e9, "frequency"), 1e9);
  });
  it("parses lengths", () => {
    assert.deepEqual(parseLength("0.25λ"), { kind: "electrical", wavelengths: 0.25 });
    near((parseLength("90deg") as { wavelengths: number }).wavelengths, 0.25);
    near((parseLength("12mm") as { meters: number }).meters, 0.012);
  });
});

describe("rf conversions", () => {
  it("round-trips Z ↔ Γ", () => {
    const z = c(25, -40);
    const g = gammaFromZ(z, 50);
    const back = zFromGamma(g, 50);
    near(back.re, 25);
    near(back.im, -40);
  });
  it("computes VSWR / return loss", () => {
    const m = impedanceMetrics(c(100, 0), 50);
    near(m.gamma_magnitude, 1 / 3);
    near(m.vswr, 2);
    near(m.return_loss_db, 9.54243, 1e-5);
  });
});

describe("transmission lines", () => {
  it("quarter-wave line inverts impedance", () => {
    const zin = inputImpedance(
      c(100),
      [{ type: "transmission_line", z0: 50, length: { kind: "electrical", wavelengths: 0.25 }, eps_eff: 1, loss_db_per_m: 0 }],
      1e9,
      1e9,
    );
    near(zin.re, 25);
    near(zin.im, 0, 1e-6);
  });
  it("half-wave line repeats load", () => {
    const zl = c(30, 20);
    const zin = inputImpedance(
      zl,
      [{ type: "transmission_line", z0: 75, length: { kind: "electrical", wavelengths: 0.5 }, eps_eff: 2.2, loss_db_per_m: 0 }],
      2e9,
      2e9,
    );
    near(zin.re, 30, 1e-6);
    near(zin.im, 20, 1e-6);
  });
  it("short stub of λ/4 is open", () => {
    const zin = inputImpedance(
      c(50),
      [
        {
          type: "stub",
          termination: "short",
          placement: "shunt",
          z0: 50,
          length: { kind: "electrical", wavelengths: 0.25 },
          eps_eff: 1,
          loss_db_per_m: 0,
        },
      ],
      1e9,
      1e9,
    );
    near(zin.re, 50, 1e-6);
  });
});

const loads = [c(100, 50), c(10, -20), c(200, 0), c(25, 80), c(50, 30), c(5, 2)];

describe("L-match", () => {
  for (const zl of loads) {
    it(`matches ${zl.re}${zl.im >= 0 ? "+" : ""}${zl.im}j to 50 Ω`, () => {
      const sols = lMatchRaw(zl, c(50));
      assert.ok(sols.length >= 2, "expected at least two solutions");
      for (const s of sols) {
        const comps = rawToComponents(s.elements, 1e9, 50);
        const zin = inputImpedance(zl, comps, 1e9, 1e9);
        near(zin.re, 50, 1e-6);
        near(zin.im, 0, 1e-6);
      }
    });
  }
  it("conjugately matches a complex source", () => {
    const zl = c(20, -30);
    const zs = c(10, 15);
    for (const s of lMatchRaw(zl, c(zs.re, -zs.im))) {
      const zin = inputImpedance(zl, rawToComponents(s.elements, 1e9, 50), 1e9, 1e9);
      assert.ok(powerWaveGamma(zin, zs) < 1e-6);
    }
  });
});

describe("Pi / T match", () => {
  for (const kind of ["pi", "t"] as const) {
    it(`${kind} network hits target with requested Q`, () => {
      const res = piTMatchRaw(c(10), c(50), 5, kind);
      assert.ok(Array.isArray(res));
      assert.equal(res.length, 4);
      for (const s of res) {
        const zin = inputImpedance(c(10), rawToComponents(s.elements, 1e9, 50), 1e9, 1e9);
        near(zin.re, 50, 1e-6);
        near(zin.im, 0, 1e-6);
      }
    });
  }
  it("rejects too-low Q", () => {
    const res = piTMatchRaw(c(10), c(50), 1, "pi");
    assert.ok(!Array.isArray(res));
  });
});

describe("single stub", () => {
  for (const placement of ["shunt", "series"] as const) {
    for (const zl of loads) {
      it(`${placement} stub matches ${zl.re}${zl.im >= 0 ? "+" : ""}${zl.im}j`, () => {
        const sols = singleStubRaw(zl, 50, 50, placement);
        assert.ok(sols.length >= 2);
        for (const s of sols) {
          const zin = inputImpedance(
            zl,
            [
              { type: "transmission_line", z0: 50, length: { kind: "electrical", wavelengths: s.distance_wavelengths }, eps_eff: 1, loss_db_per_m: 0 },
              {
                type: "stub",
                termination: s.termination,
                placement,
                z0: 50,
                length: { kind: "electrical", wavelengths: s.stub_length_wavelengths },
                eps_eff: 1,
                loss_db_per_m: 0,
              },
            ],
            1e9,
            1e9,
          );
          assert.ok(abs(gammaFromZ(zin, 50)) < 1e-6, `|Γ|=${abs(gammaFromZ(zin, 50))}`);
        }
      });
    }
  }
  it("works with a different stub impedance", () => {
    for (const s of singleStubRaw(c(60, -80), 50, 100, "shunt")) {
      const zin = inputImpedance(
        c(60, -80),
        [
          { type: "transmission_line", z0: 50, length: { kind: "electrical", wavelengths: s.distance_wavelengths }, eps_eff: 1, loss_db_per_m: 0 },
          { type: "stub", termination: s.termination, placement: "shunt", z0: 100, length: { kind: "electrical", wavelengths: s.stub_length_wavelengths }, eps_eff: 1, loss_db_per_m: 0 },
        ],
        1e9,
        1e9,
      );
      assert.ok(abs(gammaFromZ(zin, 50)) < 1e-6);
    }
  });
});

describe("quarter-wave", () => {
  for (const zl of [c(100), c(40, 30), c(150, -60)]) {
    it(`matches ${zl.re}${zl.im >= 0 ? "+" : ""}${zl.im}j`, () => {
      const opts = quarterWaveOptions(zl, 50);
      assert.ok(opts.length >= 1);
      for (const o of opts) {
        const zin = inputImpedance(
          zl,
          [
            { type: "transmission_line", z0: 50, length: { kind: "electrical", wavelengths: o.offset_wavelengths }, eps_eff: 1, loss_db_per_m: 0 },
            { type: "transmission_line", z0: o.transformer_z0, length: { kind: "electrical", wavelengths: 0.25 }, eps_eff: 1, loss_db_per_m: 0 },
          ],
          1e9,
          1e9,
        );
        assert.ok(abs(gammaFromZ(zin, 50)) < 1e-6);
      }
    });
  }
});

describe("E-series", () => {
  it("snaps to nearest value", () => {
    near(snapToSeries(4.6e-9, "E12"), 4.7e-9);
    near(snapToSeries(9.6e-12, "E12"), 10e-12);
    near(snapToSeries(1.07e3, "E96"), 1.07e3);
  });
});

// Pozar Example 12.3-ish device: GaAs FET at 4 GHz (Pozar 4th ed. Ex. 12.4 values)
const fet: TwoPort = {
  s11: fromPolar(0.72, -116),
  s21: fromPolar(2.6, 76),
  s12: fromPolar(0.03, 57),
  s22: fromPolar(0.73, -54),
};

describe("two-port", () => {
  it("stability factors (Pozar Ex. 12.4: K=1.195, |Δ|=0.488)", () => {
    const st = stability(fet);
    near(st.k, 1.195, 2e-3);
    near(st.delta_magnitude, 0.488, 2e-3);
    assert.ok(st.unconditionally_stable);
  });
  it("conjugate match gives GT,max ≈ 16.7 dB and consistent gains", () => {
    const m = conjugateMatch(fet, 50);
    assert.ok(m.feasible);
    near(m.gt_max_db as number, 16.7, 5e-3);
    near(abs(m.gamma_source as never), 0.872, 3e-3);
    near(abs(m.gamma_load as never), 0.876, 3e-3);
    const gt = 10 * Math.log10(transducerGain(fet, m.gamma_source as never, m.gamma_load as never));
    near(gt, m.gt_max_db as number, 1e-6);
  });
  it("gain circles contain the right gain", () => {
    for (const type of ["available", "operating"] as const) {
      const circ = gainCircle(fet, type, 14);
      const p = { re: circ.center.re + circ.radius, im: circ.center.im };
      const g = type === "available" ? availableGain(fet, p) : operatingGain(fet, p);
      near(10 * Math.log10(g), 14, 1e-6);
    }
  });
  it("stability circle points give |Γin| = 1 / |Γout| = 1", () => {
    const pot: TwoPort = { s11: fromPolar(0.9, -60), s21: fromPolar(5, 100), s12: fromPolar(0.1, 40), s22: fromPolar(0.6, -50) };
    const st = stability(pot);
    assert.ok(!st.unconditionally_stable);
    const pl = { re: st.load_circle.center.re + st.load_circle.radius, im: st.load_circle.center.im };
    near(abs(gammaIn(pot, pl)), 1, 1e-9);
    const ps = { re: st.source_circle.center.re, im: st.source_circle.center.im - st.source_circle.radius };
    near(abs(gammaOut(pot, ps)), 1, 1e-9);
    // Γ=0 is stable since |S11|,|S22| < 1 → region must contain the origin
    const originInsideL = abs(st.load_circle.center) < st.load_circle.radius;
    assert.equal(st.load_circle.stable_region === "inside", originInsideL);
  });
  it("noise circle points have the requested NF", () => {
    const n = { nf_min_db: 1.6, gamma_opt: fromPolar(0.62, 100), rn: 20 };
    const circ = noiseCircle(n, 50, 2.0);
    const p = { re: circ.center.re, im: circ.center.im + circ.radius };
    near(noiseFigureAt(n, 50, p), 2.0, 1e-6);
    near(noiseFigureAt(n, 50, n.gamma_opt), 1.6, 1e-9);
  });
});

describe("touchstone", () => {
  it("parses s2p with noise block", () => {
    const ts = parseTouchstone(`! test
# GHz S MA R 50
1.0 0.44 -157.6 4.725 84.3 0.094 55.4 0.339 -51.8
1.4 0.433 176.6 2.847 64.5 0.143 58.4 0.304 -58.3
! noise
1.0 1.2 0.5 120 0.4
1.4 1.4 0.5 130 0.4`);
    assert.equal(ts.ports, 2);
    assert.equal(ts.points.length, 2);
    assert.equal(ts.noise.length, 2);
    near(ts.points[1].frequency, 1.4e9);
    near(abs(ts.points[0].s21 as never), 4.725);
    near(ts.noise[0].rn, 20);
  });
  it("parses s1p in dB format", () => {
    const ts = parseTouchstone(`# MHz S DB R 75
100 -20 45
200 -10 90`);
    assert.equal(ts.ports, 1);
    near(ts.z0, 75);
    near(abs(ts.points[0].s11), 0.1);
  });
});

describe("sweep", () => {
  it("generates log sweeps", () => {
    const f = sweepFrequencies({ start: 1e6, stop: 1e9, points: 4, scale: "log" });
    near(f[1], 1e7);
  });
});
