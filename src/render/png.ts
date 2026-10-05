import { existsSync } from "node:fs";

/**
 * Optional SVG → PNG rasterisation via @resvg/resvg-js (prebuilt native binary, no browser).
 * Returns null when the optional dependency is not installed.
 */
type ResvgCtor = new (
  svg: string,
  opts: Record<string, unknown>,
) => { render(): { asPng(): Uint8Array } };

let cached: ResvgCtor | null | undefined;

// Arial on macOS/Windows; Linux servers usually only ship DejaVu (see Dockerfile). The generic
// "sans-serif" in the SVG resolves to sansSerifFamily, so both must point at an installed font.
const FONT = process.env.SMITH_CHARTS_MCP_FONT ?? (process.platform === "linux" ? "DejaVu Sans" : "Arial");
// resvg's system-font discovery misses /usr/share/fonts on some Linux images, so list the usual dirs explicitly
const FONT_DIRS = [
  ...(process.env.SMITH_CHARTS_MCP_FONT_DIRS?.split(":") ?? []),
  "/usr/share/fonts",
  "/usr/local/share/fonts",
].filter((d) => d && existsSync(d));

async function loadResvg(): Promise<ResvgCtor | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("@resvg/resvg-js")) as unknown as { Resvg: ResvgCtor };
    cached = mod.Resvg;
  } catch {
    cached = null;
  }
  return cached;
}

export async function svgToPng(svg: string, width: number, scale = 2): Promise<Buffer | null> {
  const Resvg = await loadResvg();
  if (!Resvg) return null;
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.round(width * scale) },
    font: { loadSystemFonts: true, fontDirs: FONT_DIRS, defaultFontFamily: FONT, sansSerifFamily: FONT },
  });
  return Buffer.from(r.render().asPng());
}

export async function pngAvailable(): Promise<boolean> {
  return (await loadResvg()) !== null;
}
