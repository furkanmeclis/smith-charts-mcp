import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type Lang, resolveLang } from "../i18n/index.ts";

const lang = z.string().optional().describe("Response language: 'en' (English) or 'tr' (Türkçe).");

type Args = Record<string, string | undefined>;

interface PromptDef {
  name: string;
  title: string;
  description: string;
  args: Record<string, z.ZodType<string | undefined>>;
  build: (a: Args, l: Lang) => string;
}

const reply = (l: Lang) =>
  l === "tr"
    ? "Yanıtının tamamını Türkçe yaz; araçları çağırırken language: \"tr\" kullan."
    : "Write your whole answer in English; call the tools with language: \"en\".";

const opt = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

const PROMPTS: PromptDef[] = [
  {
    name: "match_impedance",
    title: "Design an impedance-matching network",
    description: "Guided workflow: analyze a load, design and compare L / Pi-T / stub / λ/4 matching networks, verify and plot them.",
    args: {
      load: z.string().describe("Load impedance, e.g. '25-j15' (Ω) or a path to an .s1p file."),
      frequency: z.string().describe("Design frequency, e.g. '2.4GHz'."),
      z0: z.string().optional().describe("System impedance (default 50)."),
      source: z.string().optional().describe("Source impedance if not equal to Z0."),
      method: z.string().optional().describe("l | pi_t | stub | quarter_wave | compare (default compare)."),
      constraints: z.string().optional().describe("Extra requirements, e.g. 'DC block', 'low-pass', 'E24 parts', 'BW > 100 MHz'."),
      language: lang,
    },
    build: (a, l) => {
      const z0 = opt(a.z0, "50");
      const method = opt(a.method, "compare");
      const loadIsFile = /\.s1p$/i.test(a.load ?? "");
      return l === "tr"
        ? `Bir RF mühendisi gibi davran ve smith-charts-mcp araçlarını kullanarak bir empedans eşleştirme devresi tasarla.

Yük: ${a.load}${loadIsFile ? " (ölçülmüş .s1p dosyası; load.touchstone_path olarak ver)" : ""}
Frekans: ${a.frequency}
Sistem empedansı Z0: ${z0} Ω${a.source ? `\nKaynak empedansı: ${a.source}` : ""}
Yöntem: ${method}${a.constraints ? `\nKısıtlar: ${a.constraints}` : ""}

Adımlar:
1. analyze_circuit ile (bileşen olmadan) yükün Γ, VSWR ve geri dönüş kaybını bul; yükün Smith diyagramındaki yerini yorumla.
2. Yönteme göre tasarla: design_l_match, design_pi_t_match (makul bir Q seç ve gerekçelendir), design_stub_match, design_quarter_wave. "compare" ise hepsini çalıştır.
3. Her çözümü bant genişliği, DC davranışı, alçak/yüksek geçiren karakter ve parça değerlerinin gerçekçiliği açısından karşılaştır; kısıtlara en uygun olanı öner. Gerekirse snap_to_series ile standart değerlere yuvarla.
4. Önerilen çözümü analyze_circuit ile bir frekans taraması (sweep) ve bandwidth_vswr: 2 ile doğrula.
5. render_smith_chart ile yükü, devre yaylarını ve VSWR 2 çemberini çiz.
6. Sonucu tablo + kısa açıklama olarak sun: bileşen listesi (yükten kaynağa), her adımın Smith diyagramında ne yaptığı ve formüller.

${reply(l)}`
        : `Act as an RF engineer and design an impedance-matching network using the smith-charts-mcp tools.

Load: ${a.load}${loadIsFile ? " (measured .s1p file — pass it as load.touchstone_path)" : ""}
Frequency: ${a.frequency}
System impedance Z0: ${z0} Ω${a.source ? `\nSource impedance: ${a.source}` : ""}
Method: ${method}${a.constraints ? `\nConstraints: ${a.constraints}` : ""}

Steps:
1. Run analyze_circuit (no components) to get the load's Γ, VSWR and return loss; explain where it sits on the Smith chart.
2. Design with the requested method: design_l_match, design_pi_t_match (choose and justify a sensible Q), design_stub_match, design_quarter_wave. For "compare" run all of them.
3. Compare the solutions on bandwidth, DC behaviour, low/high-pass character and practicality of the part values; recommend the one that best fits the constraints. Use snap_to_series for standard values when relevant.
4. Verify the recommended network with analyze_circuit using a sweep and bandwidth_vswr: 2.
5. Plot it with render_smith_chart: the load, the circuit arcs and a VSWR 2 circle.
6. Present a table plus a short explanation: component list (load → source), what each element does on the Smith chart, and the key formulas.

${reply(l)}`;
    },
  },
  {
    name: "design_amplifier",
    title: "Design amplifier input/output matching from S-parameters",
    description: "Stability check, gain / noise trade-off and matching-network design for a transistor given as an .s2p file.",
    args: {
      touchstone_path: z.string().describe("Absolute path to the transistor .s2p file."),
      frequency: z.string().describe("Design frequency, e.g. '1.4GHz'."),
      goal: z.string().optional().describe("max_gain | low_noise | target_gain (default max_gain)."),
      target_gain_db: z.string().optional().describe("Target transducer gain in dB for goal=target_gain."),
      language: lang,
    },
    build: (a, l) => {
      const goal = opt(a.goal, "max_gain");
      const dev = `device: { touchstone_path: "${a.touchstone_path}" }, frequency: "${a.frequency}"`;
      return l === "tr"
        ? `Bir RF amplifikatör tasarımcısı olarak şu transistör için giriş/çıkış eşleştirme devrelerini tasarla.
Dosya: ${a.touchstone_path}
Frekans: ${a.frequency}
Hedef: ${goal}${a.target_gain_db ? ` (${a.target_gain_db} dB)` : ""}

1. parse_touchstone ile dosyayı özetle.
2. amplifier_stability ile (${dev}) K, |Δ|, μ ve kararlılık çemberlerini bul. Kararsızsa riskleri ve çözümleri (dirençli yükleme, geri besleme) açıkla.
3. Hedefe göre:
   - max_gain: koşulsuz kararlıysa conjugate_match (design_networks: true) kullan.
   - low_noise: noise_circles ve gain_circles (available) ile gürültü/kazanç ödünleşimini değerlendir, ΓS seç; çıkışı conjugate (ΓL = Γout*) eşleştir.
   - target_gain: gain_circles ile hedef kazanç çemberini bul, kararlı bölgede bir ΓS/ΓL seç.
4. Seçilen ΓS ve ΓL için design_l_match ile ağları tasarla (yük = Z0 sonlandırması, kaynak hedefi = cihaza sunulması gereken empedans).
5. render_smith_chart ile amplifier katmanını (kararlılık + kazanç/gürültü çemberleri) ve seçilen noktaları çiz.
6. Sonuçları tablo halinde, formülleriyle birlikte özetle.

${reply(l)}`
        : `As an RF amplifier designer, design the input and output matching networks for this transistor.
File: ${a.touchstone_path}
Frequency: ${a.frequency}
Goal: ${goal}${a.target_gain_db ? ` (${a.target_gain_db} dB)` : ""}

1. Summarize the file with parse_touchstone.
2. Run amplifier_stability (${dev}) for K, |Δ|, μ and the stability circles. If potentially unstable, explain the risk and remedies (resistive loading, feedback).
3. Depending on the goal:
   - max_gain: if unconditionally stable use conjugate_match (design_networks: true).
   - low_noise: use noise_circles and gain_circles (available) to weigh the noise/gain trade-off and choose ΓS; conjugately match the output (ΓL = Γout*).
   - target_gain: use gain_circles to find the target circle and pick ΓS/ΓL inside the stable regions.
4. Design the networks for the chosen ΓS and ΓL with design_l_match (load = Z0 termination, target = impedance to present to the device).
5. Plot with render_smith_chart using the amplifier overlay (stability + gain/noise circles) and the chosen points.
6. Summarize the results in a table with the key formulas.

${reply(l)}`;
    },
  },
  {
    name: "check_stability",
    title: "Check two-port stability",
    description: "Stability report (K, Δ, μ, stability circles, stable frequency ranges) for an .s2p device.",
    args: {
      touchstone_path: z.string().describe("Absolute path to the .s2p file."),
      frequency: z.string().optional().describe("Frequency of interest (omit to scan the whole file)."),
      language: lang,
    },
    build: (a, l) =>
      l === "tr"
        ? `${a.touchstone_path} dosyasındaki iki portlu cihazın kararlılığını analiz et.
1. amplifier_stability'yi frekans vermeden çalıştırıp tüm dosyadaki koşulsuz kararlı aralıkları çıkar.
2. ${a.frequency ? `${a.frequency} frekansında` : "En kritik (en düşük μ) frekansta"} amplifier_stability ile kararlılık çemberlerini hesapla.
3. render_smith_chart'ta amplifier.stability_circles ile çemberleri çiz (kararsız bölge taralı).
4. K, |Δ|, μ ve μ' değerlerinin anlamını, hangi kaynak/yük empedanslarının tehlikeli olduğunu ve kararlılığı sağlamak için öneriler sun.

${reply(l)}`
        : `Analyze the stability of the two-port in ${a.touchstone_path}.
1. Run amplifier_stability without a frequency to get the unconditionally stable ranges across the file.
2. Compute the stability circles with amplifier_stability at ${a.frequency ? a.frequency : "the most critical (lowest μ) frequency"}.
3. Plot them with render_smith_chart using amplifier.stability_circles (unstable side shaded).
4. Explain what K, |Δ|, μ and μ' mean here, which source/load impedances are dangerous, and how to stabilize the device.

${reply(l)}`,
  },
  {
    name: "tune_antenna",
    title: "Tune an antenna from a measured .s1p",
    description: "Find the antenna's match at a target frequency from VNA data and design a tuner (L-network or stub).",
    args: {
      touchstone_path: z.string().describe("Absolute path to the antenna .s1p measurement."),
      frequency: z.string().describe("Target frequency, e.g. '3.65MHz' or '868MHz'."),
      z0: z.string().optional().describe("System impedance (default 50)."),
      language: lang,
    },
    build: (a, l) => {
      const z0 = opt(a.z0, "50");
      return l === "tr"
        ? `${a.touchstone_path} dosyasındaki ölçülmüş antenin ${a.frequency} frekansında ${z0} Ω'a ayarlanması:
1. parse_touchstone ile rezonans/en iyi eşleşme frekansını ve hedef frekanstaki S11'i bul.
2. render_smith_chart ile touchstone_trace (S11 izi) çiz.
3. design_l_match'i load.touchstone_path ve frequency ile çalıştır (frekansa bağlı yük); gerekirse design_stub_match'i de dene.
4. Önerilen çözümü analyze_circuit ile sweep (ölçüm aralığı) ve bandwidth_vswr: 2 kullanarak doğrula; elde edilen bant genişliğini raporla.
5. Ayarlanmış devreyi (circuit + sweep) Smith diyagramında çiz ve bileşen değerlerini pratik öneriler (gerilim/akım zorlanması, Q) ile sun.

${reply(l)}`
        : `Tune the measured antenna in ${a.touchstone_path} to ${z0} Ω at ${a.frequency}:
1. Use parse_touchstone to find its resonance / best-match frequency and the S11 at the target frequency.
2. Plot its S11 locus with render_smith_chart (touchstone_trace).
3. Run design_l_match with load.touchstone_path and frequency (frequency-dependent load); try design_stub_match as an alternative if useful.
4. Verify the chosen tuner with analyze_circuit using a sweep over the measured range and bandwidth_vswr: 2; report the achieved bandwidth.
5. Plot the tuned circuit (circuit + sweep) and present the part values with practical notes (voltage/current stress, component Q).

${reply(l)}`;
    },
  },
  {
    name: "explain_smith_chart",
    title: "Explain the Smith chart (tutorial)",
    description: "Interactive lesson on reading the Smith chart, optionally around a specific impedance.",
    args: {
      impedance: z.string().optional().describe("An impedance to use as the running example, e.g. '30+j40'."),
      z0: z.string().optional().describe("Reference impedance (default 50)."),
      level: z.string().optional().describe("beginner | intermediate | advanced (default beginner)."),
      language: lang,
    },
    build: (a, l) => {
      const zEx = opt(a.impedance, "30+j40");
      const level = opt(a.level, "beginner");
      return l === "tr"
        ? `Smith diyagramını ${level} seviyesinde, ${zEx} Ω (Z0 = ${opt(a.z0, "50")} Ω) örneği üzerinden öğret.
- Normalize empedans, sabit direnç çemberleri ve sabit reaktans yayları, Γ düzlemi ile ilişki.
- impedance_convert ile örneğin z, Γ, VSWR, geri dönüş kaybı değerlerini hesapla ve render_smith_chart ile noktayı ve VSWR çemberini çiz.
- Seri L/C eklemenin sabit-R çemberinde, paralel L/C eklemenin sabit-G çemberinde, hattın ise merkez etrafında dönüş olduğunu analyze_circuit + render_smith_chart ile göster (her biri için küçük bir örnek).
- ${level === "beginner" ? "Formülleri basit tut, sezgiye odaklan." : "Formülleri türetimleriyle birlikte ver; admitans diyagramı ve Q konturlarını da ekle."}
- Sonunda öğrenciye 3 alıştırma sorusu ve cevap anahtarı ver.

${reply(l)}`
        : `Teach the Smith chart at ${level} level, using ${zEx} Ω (Z0 = ${opt(a.z0, "50")} Ω) as the running example.
- Normalized impedance, constant-resistance circles and constant-reactance arcs, and how they relate to the Γ plane.
- Use impedance_convert to compute z, Γ, VSWR and return loss for the example and render_smith_chart to plot the point and its VSWR circle.
- Show with analyze_circuit + render_smith_chart that a series L/C moves along a constant-R circle, a shunt L/C along a constant-G circle, and a transmission line rotates around the centre (one small example each).
- ${level === "beginner" ? "Keep formulas simple and focus on intuition." : "Give formulas with derivations; include the admittance chart and Q contours."}
- Finish with 3 practice problems and an answer key.

${reply(l)}`;
    },
  },
  {
    name: "solve_rf_problem",
    title: "Solve an RF / microwave homework problem step by step",
    description: "Step-by-step solution of a transmission-line / Smith chart / matching / amplifier problem, verified with the tools.",
    args: {
      problem: z.string().describe("The full problem statement."),
      language: lang,
    },
    build: (a, l) =>
      l === "tr"
        ? `Aşağıdaki RF/mikrodalga problemini adım adım çöz.

PROBLEM:
${a.problem}

Kurallar:
- Önce verilenleri ve istenenleri listele, kullanılacak formülleri yaz (Γ = (Z−Z0)/(Z+Z0), Zin = Z0(ZL + jZ0 tanβℓ)/(Z0 + jZL tanβℓ) vb.).
- Her ara sonucu uygun smith-charts-mcp aracıyla (impedance_convert, tline_input_impedance, analyze_circuit, design_* , amplifier araçları) hesapla ve elle bulduğun değerle karşılaştır.
- Smith diyagramı ile çözülebilecek her adımı render_smith_chart ile görselleştir.
- Sonuçları birimleriyle, makul anlamlı basamakla ve kutu içinde ver; son olarak sonucun fiziksel yorumunu yap.

${reply(l)}`
        : `Solve the following RF / microwave problem step by step.

PROBLEM:
${a.problem}

Rules:
- First list the givens and unknowns and write the formulas you will use (Γ = (Z−Z0)/(Z+Z0), Zin = Z0(ZL + jZ0 tanβℓ)/(Z0 + jZL tanβℓ), …).
- Compute every intermediate result with the matching smith-charts-mcp tool (impedance_convert, tline_input_impedance, analyze_circuit, design_*, amplifier tools) and cross-check against your hand calculation.
- Visualize every step that is naturally a Smith chart construction with render_smith_chart.
- Give final answers with units and sensible significant figures, clearly highlighted, then interpret the result physically.

${reply(l)}`,
  },
  {
    name: "transmission_line_problem",
    title: "Transmission-line analysis",
    description: "Input impedance, standing waves and voltage maxima/minima for a terminated line, with a Smith chart.",
    args: {
      load: z.string().describe("Load impedance, e.g. '100+j50', 'open' or 'short'."),
      length: z.string().describe("Line length, e.g. '0.3λ', '45deg' or '12cm'."),
      line_z0: z.string().optional().describe("Line characteristic impedance (default 50)."),
      frequency: z.string().optional().describe("Frequency (needed for physical lengths)."),
      velocity_factor: z.string().optional().describe("Velocity factor, e.g. '0.66'."),
      language: lang,
    },
    build: (a, l) => {
      const z0 = opt(a.line_z0, "50");
      const extras = [a.frequency ? `f = ${a.frequency}` : "", a.velocity_factor ? `VF = ${a.velocity_factor}` : ""].filter(Boolean).join(", ");
      return l === "tr"
        ? `Z0 = ${z0} Ω'luk, ${a.length} uzunluğundaki hat ${a.load} yükü ile sonlandırılmış${extras ? ` (${extras})` : ""}.
1. tline_input_impedance ile Zin, yükteki ve girişteki Γ, VSWR ve yükten ilk gerilim maksimum/minimum mesafelerini hesapla.
2. Sonuçları formülle elle doğrula ve Smith diyagramında "jeneratöre doğru" dönüşü açıkla.
3. render_smith_chart ile devreyi (load + transmission_line) ve VSWR çemberini çiz.
4. Hat boyunca gerilim dalgasının şeklini (duran dalga) yorumla.

${reply(l)}`
        : `A ${z0} Ω line of length ${a.length} is terminated in ${a.load}${extras ? ` (${extras})` : ""}.
1. Use tline_input_impedance for Zin, Γ at the load and at the input, VSWR and the distances from the load to the first voltage maximum/minimum.
2. Check the results by hand with the formulas and explain the "towards generator" rotation on the Smith chart.
3. Plot the circuit (load + transmission_line) and its VSWR circle with render_smith_chart.
4. Interpret the standing-wave pattern along the line.

${reply(l)}`;
    },
  },
];

export function registerPrompts(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.args as never }, ((args: Args) => {
      const l = resolveLang(args.language);
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: p.build(args, l) } }] };
    }) as never);
  }
}

export const PROMPT_NAMES = PROMPTS.map((p) => p.name);
