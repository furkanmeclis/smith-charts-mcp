/**
 * Single source of truth for the release history. CHANGELOG.md is generated from this file
 * (`npm run changelog`) and the `version_info` tool / smith://changelog resources serve it to clients.
 * When releasing: bump package.json, src/version.ts and server.json, add an entry at the TOP of this
 * list, run `npm run changelog`, commit and push a `vX.Y.Z` tag.
 */

export interface Bilingual {
  en: string;
  tr: string;
}

export interface ChangelogEntry {
  version: string;
  /** ISO date (YYYY-MM-DD) */
  date: string;
  summary: Bilingual;
  added?: Bilingual[];
  changed?: Bilingual[];
  fixed?: Bilingual[];
  security?: Bilingual[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.0",
    date: "2026-10-05",
    summary: {
      en: "First public release: Smith chart, impedance-matching and S-parameter toolkit over stdio and Streamable HTTP.",
      tr: "İlk herkese açık sürüm: stdio ve Streamable HTTP üzerinden Smith diyagramı, empedans eşleştirme ve S-parametre araç seti.",
    },
    added: [
      {
        en: "impedance_convert and tline_input_impedance: Z / z / Y / Γ / VSWR / return-loss conversion and lossy transmission-line input impedance with voltage max/min positions.",
        tr: "impedance_convert ve tline_input_impedance: Z / z / Y / Γ / VSWR / geri dönüş kaybı dönüşümleri ve gerilim maksimum/minimum konumlarıyla kayıplı iletim hattı giriş empedansı.",
      },
      {
        en: "analyze_circuit: load → source ladder analysis (L, C, R with Q/ESR/ESL, RLC, Z(f) tables, lines, stubs, transformers, coupled inductors) with sweeps, matched bandwidth and tolerance corners; .s1p loads supported.",
        tr: "analyze_circuit: yükten kaynağa merdiven devre analizi (Q/ESR/ESL'li L, C, R, RLC, Z(f) tabloları, hatlar, stub'lar, trafolar, kuplajlı bobinler); tarama, bant genişliği ve tolerans köşeleri; .s1p yük desteği.",
      },
      {
        en: "Matching synthesis: design_l_match, design_pi_t_match, design_stub_match and design_quarter_wave with verification, bandwidth and E-series rounding; results chain into analyze_circuit and render_smith_chart.",
        tr: "Eşleştirme sentezi: doğrulama, bant genişliği ve E-serisi yuvarlama ile design_l_match, design_pi_t_match, design_stub_match ve design_quarter_wave; sonuçlar analyze_circuit ve render_smith_chart'a zincirlenebilir.",
      },
      {
        en: "Amplifier tools: parse_touchstone, amplifier_stability (K, Δ, μ, stability circles), gain_circles, noise_circles and conjugate_match with ready-made L-networks.",
        tr: "Amplifikatör araçları: parse_touchstone, amplifier_stability (K, Δ, μ, kararlılık çemberleri), gain_circles, noise_circles ve hazır L-devreli conjugate_match.",
      },
      {
        en: "render_smith_chart: PNG/SVG charts (Z, Y or ZY grid, light/dark) with circuit arcs, sweeps, points, VSWR/Q circles, Touchstone loci and shaded stability, gain and noise circles; watermark and repository QR code on every chart.",
        tr: "render_smith_chart: devre yayları, taramalar, noktalar, VSWR/Q çemberleri, Touchstone izleri ve taralı kararlılık, kazanç ve gürültü çemberleri içeren PNG/SVG grafikler (Z, Y veya ZY ızgara, açık/koyu tema); her grafikte filigran ve repo QR kodu.",
      },
      {
        en: "version_info tool and smith://changelog resources to ask the server what changed between versions.",
        tr: "Sürümler arasında nelerin değiştiğini sunucuya sormak için version_info aracı ve smith://changelog resource'ları.",
      },
      {
        en: "7 guided prompts (matching, amplifier design, stability, antenna tuning, Smith chart lesson, homework solver, transmission lines) and bilingual reference resources.",
        tr: "7 rehberli prompt (eşleştirme, amplifikatör tasarımı, kararlılık, anten ayarı, Smith diyagramı dersi, ödev çözücü, iletim hatları) ve iki dilli referans resource'ları.",
      },
      {
        en: "English and Turkish summaries on every tool and prompt (language argument or SMITH_CHARTS_MCP_LANG).",
        tr: "Tüm araç ve prompt'larda İngilizce ve Türkçe özet (language argümanı veya SMITH_CHARTS_MCP_LANG).",
      },
      {
        en: "Stateless Streamable HTTP transport at /mcp (health check, CORS, rate limit) and a Docker image, so the server works as a remote connector on mobile and web.",
        tr: "/mcp adresinde durumsuz Streamable HTTP transport (sağlık kontrolü, CORS, hız limiti) ve Docker imajı; sunucu mobil ve web'de uzak connector olarak çalışır.",
      },
    ],
    security: [
      {
        en: "touchstone_path and output_path are disabled over HTTP unless SMITH_CHARTS_MCP_ALLOW_FS is set, so remote clients cannot read or write server files.",
        tr: "touchstone_path ve output_path, SMITH_CHARTS_MCP_ALLOW_FS ayarlanmadıkça HTTP üzerinden kapalıdır; uzak istemciler sunucu dosyalarını okuyamaz veya yazamaz.",
      },
    ],
  },
];

const SECTIONS = ["added", "changed", "fixed", "security"] as const;
const TITLES: Record<(typeof SECTIONS)[number], Bilingual> = {
  added: { en: "Added", tr: "Eklenenler" },
  changed: { en: "Changed", tr: "Değişenler" },
  fixed: { en: "Fixed", tr: "Düzeltilenler" },
  security: { en: "Security", tr: "Güvenlik" },
};

export function entryMarkdown(e: ChangelogEntry, lang: keyof Bilingual, headingLevel = 2): string {
  const h = "#".repeat(headingLevel);
  const out = [`${h} [${e.version}] - ${e.date}`, "", e.summary[lang], ""];
  for (const s of SECTIONS) {
    const items = e[s];
    if (!items?.length) continue;
    out.push(`${h}# ${TITLES[s][lang]}`, "", ...items.map((i) => `- ${i[lang]}`), "");
  }
  return out.join("\n");
}

export function changelogMarkdown(lang: keyof Bilingual): string {
  const head =
    lang === "en"
      ? "# Changelog\n\nAll notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).\n"
      : "# Değişiklik günlüğü\n\nProjedeki tüm önemli değişiklikler burada listelenir. Biçim [Keep a Changelog](https://keepachangelog.com/tr-TR/1.1.0/) standardını izler ve proje [Anlamsal Sürümleme](https://semver.org/lang/tr/) kullanır.\n";
  return `${head}\n${CHANGELOG.map((e) => entryMarkdown(e, lang)).join("\n")}`;
}

/** Numeric semver comparison (pre-release tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const pb = b.replace(/^v/, "").split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
