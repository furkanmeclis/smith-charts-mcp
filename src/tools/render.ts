import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { filesystemAllowed } from "../config.ts";
import { cascade, componentArcs, inputImpedance, sweepFrequencies } from "../core/circuit.ts";
import { type Complex, c, format } from "../core/complex.ts";
import { gammaFromZ, zFromGamma } from "../core/rf.ts";
import { gainCircle, interpolateNoise, noiseCircle, stability, type Touchstone } from "../core/sparams.ts";
import { formatSI } from "../core/units.ts";
import { pngAvailable, svgToPng } from "../render/png.ts";
import { type ChartCircle, type ChartMarker, type ChartTrace, circleVisible, PALETTE, renderSmithSvg } from "../render/svg.ts";
import { resolveLang, t } from "../i18n/index.ts";
import { describeComponent } from "./circuit.ts";
import { defineTool, ok } from "./format.ts";
import {
  complexSchema,
  componentSchema,
  deviceSchema,
  frequencySchema,
  gammaSchema,
  InputError,
  languageSchema,
  loadSchema,
  loadTouchstone,
  parseComplex,
  parseGamma,
  q,
  resolveComponent,
  resolveDevice,
  resolveLoad,
  resolveSweep,
  sweepSchema,
  touchstoneSourceSchema,
} from "./schemas.ts";

const colorSchema = z.string().optional().describe("CSS colour, e.g. '#e11d48' or 'teal'.");

export function registerRenderTool(server: McpServer): void {
  defineTool(
    server,
    "render_smith_chart",
    {
      title: "Render a Smith chart (PNG / SVG)",
      description: [
        "Draw a publication-quality Smith chart and return it as an image (PNG, via resvg) and/or SVG.",
        "Layers (all optional, combine freely): a circuit (load + components listed load → source) drawn as the classic",
        "constant-R / constant-G / transmission-line arcs with a node marker per component, plus an optional frequency-sweep",
        "trace of the input; impedance or Γ points; VSWR circles; constant-Q contours; arbitrary circles (e.g. from",
        "gain_circles / noise_circles / amplifier_stability, centre given as Γ); an S11/S22 locus from a Touchstone file;",
        "and amplifier overlays computed from a device (stability circles with the unstable side shaded, available/operating",
        "gain circles, noise-figure circles). Impedance, admittance or combined grid; light or dark theme;",
        "optional output_path to also save the file.",
      ].join(" "),
      readOnly: false,
      inputSchema: {
        z0: z.number().positive().default(50).describe("Chart reference impedance Z0 (Ω)."),
        title: z.string().optional().describe("Chart title."),
        grid: z.enum(["impedance", "admittance", "both"]).default("both").describe("Grid type: Z chart, Y chart or combined ZY chart."),
        theme: z.enum(["light", "dark"]).default("light"),
        size: z.number().int().min(240).max(2000).default(640).describe("Chart width in px."),
        png_scale: z.number().min(0.5).max(3).default(2).describe("PNG pixel density multiplier (2 = crisp on HiDPI; 1 = smaller payload)."),
        format: z.enum(["png", "svg", "both"]).default("png").describe("Returned image format."),
        output_path: z.string().optional().describe("Absolute file path to also write the image to (.png or .svg; with format 'both' both files are written)."),
        circuit: z
          .object({
            load: loadSchema,
            components: z.array(componentSchema).default([]).describe("Elements ordered load → source."),
            frequency: frequencySchema,
            sweep: sweepSchema.optional().describe("Also plot the input impedance locus over this frequency range."),
          })
          .optional()
          .describe("Circuit to draw as Smith chart arcs (same format as analyze_circuit)."),
        points: z
          .array(
            z.object({
              z: complexSchema.optional(),
              gamma: gammaSchema.optional(),
              label: z.string().optional(),
              color: colorSchema,
            }),
          )
          .optional()
          .describe("Individual impedances (z) or reflection coefficients (gamma) to mark."),
        vswr_circles: z.array(z.number().gt(1)).optional().describe("Constant-VSWR circles to draw, e.g. [1.5, 2, 3]."),
        q_contours: z.array(z.number().positive()).optional().describe("Constant-Q contours (|X|/R = Q), e.g. [1, 2, 5]."),
        circles: z
          .array(
            z.object({
              center_gamma: gammaSchema.describe("Circle centre in the Γ plane (as returned by gain/noise/stability tools)."),
              radius: z.number().min(0).describe("Radius in Γ units."),
              label: z.string().optional(),
              color: colorSchema,
              dashed: z.boolean().optional(),
              shade: z.enum(["inside", "outside"]).optional().describe("Shade this side of the circle (e.g. the unstable region)."),
            }),
          )
          .optional()
          .describe("Arbitrary circles in the Γ plane."),
        touchstone_trace: z
          .object({
            ...touchstoneSourceSchema,
            parameter: z.enum(["s11", "s22"]).default("s11"),
            start: frequencySchema.optional(),
            stop: frequencySchema.optional(),
            label: z.string().optional(),
          })
          .optional()
          .describe("Plot the S11 (or S22) locus of a Touchstone file, e.g. a measured antenna."),
        amplifier: z
          .object({
            device: deviceSchema,
            frequency: frequencySchema.optional(),
            stability_circles: z.boolean().default(true).describe("Draw source/load stability circles with the unstable side shaded."),
            available_gain_db: z.array(z.number()).optional().describe("Available-gain circles (source plane), dB."),
            operating_gain_db: z.array(z.number()).optional().describe("Operating-gain circles (load plane), dB."),
            noise_figure_db: z.array(z.number()).optional().describe("Noise-figure circles (source plane), dB — needs noise data."),
          })
          .optional()
          .describe("Amplifier overlays computed from a two-port."),
        language: languageSchema,
      },
    },
    async (a) => {
      const lang = resolveLang(a.language);
      const traces: ChartTrace[] = [];
      const circles: ChartCircle[] = [];
      const markers: ChartMarker[] = [];
      const notes: string[] = [];
      let colorIdx = 0;
      const nextColor = () => PALETTE[colorIdx++ % PALETTE.length];

      if (a.circuit) {
        const f0 = q(a.circuit.frequency, "frequency");
        const load = resolveLoad(a.circuit.load, a.z0);
        const comps = a.circuit.components.map((ci) => resolveComponent(ci, a.z0));
        const zl = load.fn(f0);
        markers.push({ gamma: gammaFromZ(zl, a.z0), label: t(lang, "Load", "Yük"), color: "#111827" });
        const arcs = componentArcs(zl, comps, f0, f0, a.z0);
        arcs.forEach((pts, i) => {
          traces.push({ points: pts, label: `${i + 1}. ${comps[i].label ?? describeComponent(comps[i])}`, color: nextColor(), end_marker: true });
        });
        const nodes = cascade(zl, comps, f0, f0);
        const zin = nodes[nodes.length - 1];
        if (comps.length) markers.push({ gamma: gammaFromZ(zin, a.z0), label: "Zin", color: "#111827" });
        notes.push(t(lang, `Circuit at ${formatSI(f0, "Hz")}: Zin = ${format(zin)} Ω`, `${formatSI(f0, "Hz")} frekansında devre: Zin = ${format(zin)} Ω`));
        if (a.circuit.sweep) {
          const spec = resolveSweep(a.circuit.sweep, f0);
          const pts = sweepFrequencies({ ...spec, points: Math.min(spec.points, 801) }).map((f) =>
            gammaFromZ(inputImpedance(load.fn(f), comps, f, f0), a.z0),
          );
          traces.push({
            points: pts,
            label: t(lang, `Zin sweep ${formatSI(spec.start, "Hz")}–${formatSI(spec.stop, "Hz")}`, `Zin taraması ${formatSI(spec.start, "Hz")}–${formatSI(spec.stop, "Hz")}`),
            color: "#0f172a",
            dashed: true,
            width: 1.8,
          });
        }
      }

      for (const p of a.points ?? []) {
        if ((p.z === undefined) === (p.gamma === undefined)) throw new InputError("each point needs exactly one of z or gamma");
        const g = p.gamma ? parseGamma(p.gamma) : gammaFromZ(parseComplex(p.z as never), a.z0);
        markers.push({ gamma: g, label: p.label, color: p.color });
      }

      for (const v of a.vswr_circles ?? []) {
        circles.push({ center: c(0), radius: (v - 1) / (v + 1), label: `VSWR ${v}`, color: nextColor(), dashed: true });
      }
      for (const qq of a.q_contours ?? []) {
        const col = nextColor();
        const r = Math.sqrt(1 + 1 / (qq * qq));
        circles.push({ center: c(0, 1 / qq), radius: r, label: `Q = ${qq}`, color: col, dashed: true });
        circles.push({ center: c(0, -1 / qq), radius: r, color: col, dashed: true });
      }
      for (const ci of a.circles ?? []) {
        circles.push({ center: parseGamma(ci.center_gamma), radius: ci.radius, label: ci.label, color: ci.color ?? nextColor(), dashed: ci.dashed, shade: ci.shade });
      }

      if (a.touchstone_trace) {
        const ts: Touchstone = loadTouchstone(a.touchstone_trace);
        const fa = a.touchstone_trace.start !== undefined ? q(a.touchstone_trace.start, "frequency") : -Infinity;
        const fb = a.touchstone_trace.stop !== undefined ? q(a.touchstone_trace.stop, "frequency") : Infinity;
        const sel = ts.points.filter((p) => p.frequency >= fa && p.frequency <= fb);
        if (sel.length === 0) throw new InputError("touchstone_trace: no points in the requested range");
        const param = a.touchstone_trace.parameter;
        if (param === "s22" && ts.ports !== 2) throw new InputError("s22 requires a 2-port file");
        // re-reference the measured Γ to the chart Z0
        const pts = sel.map((p) => {
          const g = (param === "s11" ? p.s11 : p.s22) as Complex;
          return ts.z0 === a.z0 ? g : gammaFromZ(zFromGamma(g, ts.z0), a.z0);
        });
        const col = nextColor();
        traces.push({ points: pts, label: a.touchstone_trace.label ?? `${param.toUpperCase()} ${formatSI(sel[0].frequency, "Hz")}–${formatSI(sel[sel.length - 1].frequency, "Hz")}`, color: col, width: 2 });
        markers.push({ gamma: pts[0], label: formatSI(sel[0].frequency, "Hz"), color: col });
        markers.push({ gamma: pts[pts.length - 1], label: formatSI(sel[sel.length - 1].frequency, "Hz"), color: col });
      }

      if (a.amplifier) {
        const dev = resolveDevice(a.amplifier.device, a.amplifier.frequency);
        const fTxt = dev.f ? ` @ ${formatSI(dev.f, "Hz")}` : "";
        if (a.amplifier.stability_circles) {
          const st = stability(dev.s);
          circles.push({
            center: st.source_circle.center,
            radius: st.source_circle.radius,
            label: t(lang, `Input (source) stability${fTxt}`, `Giriş (kaynak) kararlılık${fTxt}`),
            color: "#dc2626",
            shade: st.source_circle.stable_region === "inside" ? "outside" : "inside",
          });
          circles.push({
            center: st.load_circle.center,
            radius: st.load_circle.radius,
            label: t(lang, `Output (load) stability${fTxt}`, `Çıkış (yük) kararlılık${fTxt}`),
            color: "#9333ea",
            dashed: true,
            shade: st.load_circle.stable_region === "inside" ? "outside" : "inside",
          });
          notes.push(
            st.unconditionally_stable
              ? t(lang, `Device unconditionally stable (μ = ${st.mu_load.toFixed(3)})`, `Cihaz koşulsuz kararlı (μ = ${st.mu_load.toFixed(3)})`)
              : t(lang, `Device potentially unstable (μ = ${st.mu_load.toFixed(3)}); shaded = unstable`, `Cihaz potansiyel kararsız (μ = ${st.mu_load.toFixed(3)}); taralı bölge = kararsız`),
          );
        }
        for (const g of a.amplifier.available_gain_db ?? []) {
          const ci = gainCircle(dev.s, "available", g);
          if (ci.achievable) circles.push({ center: ci.center, radius: ci.radius, label: `GA ${g} dB`, color: nextColor() });
          else notes.push(t(lang, `GA ${g} dB not achievable`, `GA ${g} dB ulaşılamaz`));
        }
        for (const g of a.amplifier.operating_gain_db ?? []) {
          const ci = gainCircle(dev.s, "operating", g);
          if (ci.achievable) circles.push({ center: ci.center, radius: ci.radius, label: `GP ${g} dB`, color: nextColor(), dashed: true });
          else notes.push(t(lang, `GP ${g} dB not achievable`, `GP ${g} dB ulaşılamaz`));
        }
        if (a.amplifier.noise_figure_db?.length) {
          const n = dev.touchstone && dev.f ? interpolateNoise(dev.touchstone, dev.f) : null;
          if (!n) throw new InputError("noise_figure_db needs a Touchstone device with a noise block and a frequency");
          for (const nf of a.amplifier.noise_figure_db) {
            const ci = noiseCircle(n.noise, dev.z0, nf);
            if (ci.achievable) circles.push({ center: ci.center, radius: ci.radius, label: `NF ${nf} dB`, color: nextColor(), dashed: true });
          }
          markers.push({ gamma: n.noise.gamma_opt, label: "Γopt", color: "#0d9488" });
        }
      }

      const hidden = circles.filter((ci) => ci.label && !circleVisible(ci)).map((ci) => ci.label as string);
      if (hidden.length)
        notes.push(t(lang, `Outside the chart (not drawn): ${hidden.join(", ")}`, `Grafik dışında kalan (çizilmedi): ${hidden.join(", ")}`));
      if (!traces.length && !circles.length && !markers.length)
        notes.push(t(lang, "Empty chart (no layers given).", "Boş grafik (katman verilmedi)."));

      const svg = renderSmithSvg(
        { size: a.size, theme: a.theme, grid: a.grid, z0: a.z0, title: a.title, show_labels: true, show_legend: true },
        { traces, circles, markers },
      );
      const content: { type: "image"; data: string; mimeType: string }[] = [];
      const extraText: string[] = [];
      let png: Buffer | null = null;
      if (a.format !== "svg") {
        png = await svgToPng(svg, a.size, a.png_scale);
        if (png) content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        else
          extraText.push(
            t(lang, "PNG rendering unavailable (optional @resvg/resvg-js not installed) — returning SVG instead.", "PNG çizimi kullanılamıyor (@resvg/resvg-js kurulu değil) — bunun yerine SVG döndürülüyor."),
          );
      }
      const wantSvg = a.format !== "png" || !png;
      const saved: string[] = [];
      if (a.output_path) {
        if (!filesystemAllowed()) throw new InputError("output_path is disabled on this remote server; use the returned image instead");
        if (!isAbsolute(a.output_path)) throw new InputError("output_path must be an absolute path");
        const base = a.output_path.replace(/\.(png|svg)$/i, "");
        if (png && a.format !== "svg") {
          const p = a.format === "both" || !/\.svg$/i.test(a.output_path) ? `${base}.png` : a.output_path;
          writeFileSync(p, png);
          saved.push(p);
        }
        if (wantSvg) {
          writeFileSync(`${base}.svg`, svg, "utf8");
          saved.push(`${base}.svg`);
        }
      }
      const legend = [...traces, ...circles.filter(circleVisible)].filter((x) => x.label).map((x) => `• ${x.label}`);
      const summary = [
        t(lang, `Smith chart (Z0 = ${a.z0} Ω, ${a.grid} grid).`, `Smith diyagramı (Z0 = ${a.z0} Ω, ${a.grid === "both" ? "Z+Y" : a.grid === "impedance" ? "empedans" : "admitans"} ızgarası).`),
        ...notes,
        ...legend,
        ...extraText,
        ...(saved.length ? [t(lang, `Saved: ${saved.join(", ")}`, `Kaydedildi: ${saved.join(", ")}`)] : []),
      ].join("\n");
      const res = ok(summary, { layers: { traces: traces.length, circles: circles.length, markers: markers.length }, saved, png_available: await pngAvailable() });
      // image first so clients show it prominently; keep summary text after it
      res.content = [...content, res.content[0], ...(wantSvg ? [{ type: "text" as const, text: svg }] : [])];
      return res;
    },
  );
}
