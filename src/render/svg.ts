import { abs, type Complex, c, div, sub, ONE, add } from "../core/complex.ts";
import { QR_ROWS, QR_URL } from "./qr-data.ts";

export const WATERMARK = "furkanmeclis/smith-charts-mcp";

/** Everything drawn on the chart lives in the Γ plane (unit disk = passive impedances). */
export interface ChartTrace {
  points: Complex[];
  label?: string;
  color?: string;
  dashed?: boolean;
  width?: number;
  /** draw a dot at the last point (e.g. the node a component ends on) */
  end_marker?: boolean;
}

export interface ChartCircle {
  center: Complex;
  radius: number;
  label?: string;
  color?: string;
  dashed?: boolean;
  /** shade the unstable side of a stability circle */
  shade?: "inside" | "outside";
}

export interface ChartMarker {
  gamma: Complex;
  label?: string;
  color?: string;
}

export interface ChartOptions {
  size: number;
  theme: "light" | "dark";
  grid: "impedance" | "admittance" | "both";
  z0: number;
  title?: string;
  show_labels: boolean;
  show_legend: boolean;
}

export const PALETTE = ["#2563eb", "#e11d48", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#475569", "#ea580c"];

const THEMES = {
  light: { bg: "#ffffff", grid: "#c3c8d1", gridMajor: "#9aa1ad", adm: "#e7a8a8", text: "#3b4250", muted: "#7a818e", rim: "#5b6270" },
  dark: { bg: "#111418", grid: "#343a44", gridMajor: "#4b5360", adm: "#6b3b3b", text: "#d5d9e0", muted: "#8a919d", rim: "#a3aab5" },
};

const R_VALUES = [0.2, 0.5, 1, 2, 5];
const X_VALUES = [0.2, 0.5, 1, 2, 5];

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const n = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(2)) : 0);

export function renderSmithSvg(
  opts: ChartOptions,
  layers: { traces?: ChartTrace[]; circles?: ChartCircle[]; markers?: ChartMarker[] },
): string {
  const th = THEMES[opts.theme];
  const S = opts.size;
  const titleH = opts.title ? 30 : 0;
  const margin = Math.max(28, S * 0.06);
  const R = S / 2 - margin;
  const cx = S / 2;
  const cy = titleH + S / 2;

  const traces = layers.traces ?? [];
  const circles = layers.circles ?? [];
  const markers = layers.markers ?? [];
  const legendItems = opts.show_legend
    ? [
        ...traces.filter((t) => t.label).map((t) => ({ label: t.label as string, color: t.color as string, dashed: t.dashed })),
        ...circles.filter((t) => t.label && circleVisible(t)).map((t) => ({ label: t.label as string, color: t.color as string, dashed: t.dashed })),
      ]
    : [];
  const longest = legendItems.reduce((m, it) => Math.max(m, it.label.length), 0);
  const cols = Math.max(1, Math.min(4, Math.floor(S / Math.max(170, longest * 7 + 52))));
  const legendH = legendItems.length ? Math.ceil(legendItems.length / cols) * 20 + 14 : 0;
  const H = titleH + S + legendH;

  const px = (g: Complex) => `${n(cx + R * g.re)},${n(cy - R * g.im)}`;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${H}" viewBox="0 0 ${S} ${H}" font-family="Inter, Helvetica, Arial, 'DejaVu Sans', sans-serif">`,
    `<defs><clipPath id="disk"><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}"/></clipPath>`,
  );
  circles.forEach((ci, i) => {
    if (!ci.shade) return;
    // mask = unit disk, with the circle either kept (shade inside) or cut out (shade outside)
    const keepInside = ci.shade === "inside";
    out.push(
      `<mask id="shade${i}"><rect x="0" y="0" width="${S}" height="${H}" fill="black"/>`,
      keepInside
        ? `<circle cx="${n(cx + R * ci.center.re)}" cy="${n(cy - R * ci.center.im)}" r="${n(R * ci.radius)}" fill="white"/>`
        : `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="white"/><circle cx="${n(cx + R * ci.center.re)}" cy="${n(cy - R * ci.center.im)}" r="${n(R * ci.radius)}" fill="black"/>`,
      `</mask>`,
    );
  });
  out.push(`</defs>`, `<rect width="${S}" height="${H}" fill="${th.bg}"/>`);
  // faint diagonal watermark behind everything
  out.push(
    `<text x="${n(cx)}" y="${n(cy)}" text-anchor="middle" dominant-baseline="middle" font-size="${n(S / 17)}" font-weight="700" textLength="${n(R * 1.55)}" lengthAdjust="spacingAndGlyphs" fill="${th.text}" fill-opacity="0.05" transform="rotate(-30 ${n(cx)} ${n(cy)})">${WATERMARK}</text>`,
    `<text x="${n(S - 8)}" y="${n(titleH + 14)}" text-anchor="end" font-size="${n(Math.max(9, S / 64))}" fill="${th.muted}" fill-opacity="0.75">${WATERMARK}</text>`,
  );
  if (opts.title)
    out.push(`<text x="${n(S / 2)}" y="21" text-anchor="middle" font-size="15" font-weight="600" fill="${th.text}">${esc(opts.title)}</text>`);

  // ---------------- grid
  out.push(`<g clip-path="url(#disk)" fill="none">`);
  if (opts.grid !== "impedance") {
    out.push(`<g stroke="${th.adm}" stroke-width="0.8" stroke-dasharray="3,3">`);
    for (const g of R_VALUES) out.push(circle(cx + (R * -g) / (1 + g), cy, R / (1 + g)));
    for (const b of X_VALUES) {
      out.push(circle(cx - R, cy - R / b, R / b));
      out.push(circle(cx - R, cy + R / b, R / b));
    }
    out.push(`</g>`);
  }
  if (opts.grid !== "admittance") {
    out.push(`<g stroke="${th.grid}" stroke-width="0.9">`);
    for (const r of R_VALUES) out.push(circle(cx + (R * r) / (1 + r), cy, R / (1 + r), r === 1 ? th.gridMajor : undefined));
    for (const x of X_VALUES) {
      out.push(circle(cx + R, cy - R / x, R / x, x === 1 ? th.gridMajor : undefined));
      out.push(circle(cx + R, cy + R / x, R / x, x === 1 ? th.gridMajor : undefined));
    }
    out.push(`</g>`);
  }
  out.push(`<line x1="${n(cx - R)}" y1="${n(cy)}" x2="${n(cx + R)}" y2="${n(cy)}" stroke="${th.gridMajor}" stroke-width="0.9"/>`);
  out.push(`</g>`);
  out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="none" stroke="${th.rim}" stroke-width="1.6"/>`);

  if (opts.show_labels) {
    out.push(`<g font-size="${n(Math.max(9, S / 60))}" fill="${th.muted}">`);
    for (const r of [0, ...R_VALUES]) {
      const gx = (r - 1) / (r + 1);
      out.push(`<text x="${n(cx + R * gx + 2)}" y="${n(cy - 3)}">${r}</text>`);
    }
    for (const x of X_VALUES) {
      for (const sgn of [1, -1]) {
        const g = div(sub(c(0, sgn * x), ONE), add(c(0, sgn * x), ONE));
        const lx = cx + R * 1.075 * g.re;
        const ly = cy - R * 1.075 * g.im;
        out.push(
          `<text x="${n(lx)}" y="${n(ly + 4)}" text-anchor="middle">${sgn > 0 ? "+" : "−"}j${x}</text>`,
        );
      }
    }
    out.push(`<text x="${n(cx + R + 4)}" y="${n(cy + 4)}">∞</text>`);
    out.push(
      `<text x="8" y="${n(titleH + S - 8)}" font-size="${n(Math.max(10, S / 55))}" fill="${th.text}">Z0 = ${esc(String(opts.z0))} Ω</text>`,
    );
    out.push(`</g>`);
  }

  // ---------------- circles (gain / noise / stability / VSWR / Q)
  circles.forEach((ci, i) => {
    const color = ci.color ?? PALETTE[i % PALETTE.length];
    if (ci.shade)
      out.push(
        `<g clip-path="url(#disk)"><rect x="0" y="0" width="${S}" height="${H}" fill="${color}" fill-opacity="0.13" mask="url(#shade${i})"/></g>`,
      );
    if (!circleVisible(ci)) return;
    out.push(
      `<g clip-path="url(#disk)"><circle cx="${n(cx + R * ci.center.re)}" cy="${n(cy - R * ci.center.im)}" r="${n(R * ci.radius)}" fill="none" stroke="${color}" stroke-width="1.8"${ci.dashed ? ' stroke-dasharray="6,4"' : ""}/></g>`,
    );
  });

  // ---------------- traces (component arcs, frequency sweeps)
  traces.forEach((t, i) => {
    const color = t.color ?? PALETTE[i % PALETTE.length];
    const pts = t.points.filter((p) => Number.isFinite(p.re) && Number.isFinite(p.im) && abs(p) < 50);
    if (pts.length === 0) return;
    if (pts.length > 1)
      out.push(
        `<polyline points="${pts.map(px).join(" ")}" fill="none" stroke="${color}" stroke-width="${t.width ?? 2.4}" stroke-linejoin="round" stroke-linecap="round"${t.dashed ? ' stroke-dasharray="7,5"' : ""}/>`,
      );
    if (t.end_marker) {
      const e = pts[pts.length - 1];
      out.push(`<circle cx="${n(cx + R * e.re)}" cy="${n(cy - R * e.im)}" r="3.2" fill="${color}"/>`);
    }
  });

  // ---------------- markers
  markers.forEach((m, i) => {
    const color = m.color ?? PALETTE[(i + traces.length) % PALETTE.length];
    const x = cx + R * m.gamma.re;
    const y = cy - R * m.gamma.im;
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="5" fill="${color}" stroke="${th.bg}" stroke-width="1.5"/>`);
    if (m.label)
      out.push(
        `<text x="${n(x + 8)}" y="${n(y - 7)}" font-size="${n(Math.max(10, S / 52))}" font-weight="600" fill="${color}" stroke="${th.bg}" stroke-width="3" paint-order="stroke">${esc(m.label)}</text>`,
      );
  });

  // ---------------- legend
  if (legendItems.length) {
    const colW = S / cols;
    legendItems.forEach((it, i) => {
      const x = 14 + (i % cols) * colW;
      const y = titleH + S + 14 + Math.floor(i / cols) * 20;
      out.push(
        `<line x1="${n(x)}" y1="${n(y)}" x2="${n(x + 22)}" y2="${n(y)}" stroke="${it.color}" stroke-width="3"${it.dashed ? ' stroke-dasharray="5,3"' : ""}/>`,
        `<text x="${n(x + 28)}" y="${n(y + 4)}" font-size="12" fill="${th.text}">${esc(truncate(it.label, Math.floor(colW / 7.2) - 5))}</text>`,
      );
    });
  }
  out.push(qrCode(S, titleH, R), `</svg>`);
  return out.join("\n");

  function circle(x: number, y: number, r: number, stroke?: string): string {
    return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"${stroke ? ` stroke="${stroke}"` : ""}/>`;
  }
}

/** True when part of the circle's outline lies inside the chart's unit disk. */
export function circleVisible(ci: { center: Complex; radius: number }): boolean {
  const d = abs(ci.center);
  return d - ci.radius < 1 && ci.radius - d < 1;
}

/**
 * QR code (repository link) in the chart square's bottom-right corner, sized so it never touches the
 * unit circle. Always black on white so it stays scannable in the dark theme.
 */
function qrCode(S: number, titleH: number, R: number): string {
  const pad = 6;
  const gap = 10;
  const side = Math.min(132, S / 2 - (R + gap) / Math.SQRT2 - pad);
  const nMod = QR_ROWS.length + 4; // 2-module quiet zone each side
  const m = side / nMod;
  const x0 = S - pad - side;
  const y0 = titleH + S - pad - side;
  let d = "";
  QR_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "1") {
        x++;
        continue;
      }
      let w = 0;
      while (row[x + w] === "1") w++;
      d += `M${n(x0 + (x + 2) * m)} ${n(y0 + (y + 2) * m)}h${n(w * m)}v${n(m)}h${n(-w * m)}z`;
      x += w;
    }
  });
  return [
    `<a href="${QR_URL}"><g>`,
    `<title>${QR_URL}</title>`,
    `<rect x="${n(x0)}" y="${n(y0)}" width="${n(side)}" height="${n(side)}" rx="${n(m * 1.5)}" fill="#ffffff" stroke="#d6dae1" stroke-width="0.8"/>`,
    `<path d="${d}" fill="#0b0d10" shape-rendering="crispEdges"/>`,
    `</g></a>`,
  ].join("");
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);
