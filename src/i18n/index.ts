export type Lang = "en" | "tr";

export const LANGS: readonly Lang[] = ["en", "tr"] as const;

/** Server default: SMITH_CHARTS_MCP_LANG env (en|tr), otherwise English. */
export function defaultLang(): Lang {
  const env = (process.env.SMITH_CHARTS_MCP_LANG ?? process.env.LANG ?? "").toLowerCase();
  if (env.startsWith("tr")) return "tr";
  return "en";
}

export function resolveLang(requested?: string): Lang {
  if (requested === "en" || requested === "tr") return requested;
  return defaultLang();
}

/** Inline bilingual string. Keeps translations next to the code that uses them. */
export const t = (lang: Lang, en: string, tr: string): string => (lang === "tr" ? tr : en);
