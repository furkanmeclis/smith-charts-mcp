import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { changelogMarkdown } from "../changelog.ts";

const FORMULAS_EN = `# RF / Smith chart formula sheet

## Reflection & mismatch
- Γ = (Z − Z0) / (Z + Z0),   Z = Z0 (1 + Γ) / (1 − Γ),   z = Z / Z0
- VSWR = (1 + |Γ|) / (1 − |Γ|),   |Γ| = (VSWR − 1) / (VSWR + 1)
- Return loss RL = −20 log10 |Γ| dB,   mismatch loss ML = −10 log10 (1 − |Γ|²) dB
- Power-wave Γ for a complex source: |Γ| = |Zin − Zs*| / |Zin + Zs|
- Q of a node: Q = |X| / R ;   constant-Q contours on the chart: circles centred at (0, ±1/Q), radius √(1 + 1/Q²)

## Smith chart geometry (Γ plane)
- constant r circle: centre (r/(1+r), 0), radius 1/(1+r)
- constant x arc: centre (1, 1/x), radius 1/|x|
- admittance chart = impedance chart rotated 180° (Γ_y = −Γ)
- series L/C → move on a constant-r circle; shunt L/C → move on a constant-g circle;
  lossless line → rotate clockwise ("towards generator") around the centre by 2βℓ (λ/2 = full turn)

## Transmission lines
- Zin = Z0 (ZL + Z0 tanh γℓ) / (Z0 + ZL tanh γℓ),  γ = α + jβ,  β = 2π f √εeff / c
- lossless: Zin = Z0 (ZL + jZ0 tan βℓ) / (Z0 + jZL tan βℓ)
- open stub: Z = −jZ0 cot βℓ ;  short stub: Z = jZ0 tan βℓ
- λ/4 transformer: Z1 = √(Z0 · RL) ;  λ/2 line repeats the load
- voltage maximum at d_max = θΓ λ / 4π from the load, minimum λ/4 further

## L-network (real Rs, RL; R_high/R_low)
- Q = √(R_high / R_low − 1),  X_series = Q · R_low,  X_shunt = R_high / Q
- Pi: virtual R = R_high / (Q² + 1) ;  T: virtual R = R_low (Q² + 1)
- Element values: L = X/ω, C = 1/(ωX);  shunt: C = B/ω, L = 1/(ω|B|)

## Single stub (Pozar §5.2, shunt)
- t = [X_L ± √(R_L((Z0 − R_L)² + X_L²)/Z0)] / (R_L − Z0)   (t = −X_L/2Z0 if R_L = Z0)
- d/λ = atan(t)/2π (t ≥ 0) or (π + atan t)/2π (t < 0)
- B = [R_L² t − (Z0 − X_L t)(X_L + Z0 t)] / (Z0 [R_L² + (X_L + Z0 t)²])
- open stub: ℓ/λ = atan(−B/Y0)/2π ;  short stub: ℓ/λ = atan(Y0/B)/2π  (mod λ/2)

## Two-port amplifiers
- Δ = S11 S22 − S12 S21
- Rollett K = (1 − |S11|² − |S22|² + |Δ|²) / (2 |S12 S21|);  unconditionally stable ⇔ K > 1 and |Δ| < 1
- μ = (1 − |S11|²) / (|S22 − Δ S11*| + |S12 S21|) > 1  ⇔ unconditionally stable (single test)
- Γin = S11 + S12 S21 ΓL / (1 − S22 ΓL),   Γout = S22 + S12 S21 ΓS / (1 − S11 ΓS)
- Load stability circle: C_L = (S22 − Δ S11*)* / (|S22|² − |Δ|²),  R_L = |S12 S21| / ||S22|² − |Δ|²|
- Source stability circle: C_S = (S11 − Δ S22*)* / (|S11|² − |Δ|²),  R_S = |S12 S21| / ||S11|² − |Δ|²|
- G_T = (1 − |ΓS|²)|S21|²(1 − |ΓL|²) / (|1 − ΓS Γin|² |1 − S22 ΓL|²)
- MSG = |S21| / |S12|,  MAG = G_T,max = MSG (K − √(K² − 1))
- Conjugate match: ΓS = [B1 − √(B1² − 4|C1|²)] / 2C1, B1 = 1 + |S11|² − |S22|² − |Δ|², C1 = S11 − Δ S22*  (similarly ΓL)
- Unilateral: G_S,max = 1/(1 − |S11|²), U = |S12 S21 S11 S22| / ((1 − |S11|²)(1 − |S22|²)), error 1/(1±U)²

## Noise
- F = Fmin + (4 rn |ΓS − Γopt|²) / ((1 − |ΓS|²) |1 + Γopt|²),  rn = Rn / Z0
- N = (F − Fmin) |1 + Γopt|² / (4 rn);  circle centre Γopt / (N + 1), radius √(N(N + 1 − |Γopt|²)) / (N + 1)
`;

const FORMULAS_TR = `# RF / Smith diyagramı formül kartı

## Yansıma ve uyumsuzluk
- Γ = (Z − Z0) / (Z + Z0),   Z = Z0 (1 + Γ) / (1 − Γ),   z = Z / Z0 (normalize empedans)
- VSWR (duran dalga oranı) = (1 + |Γ|) / (1 − |Γ|),   |Γ| = (VSWR − 1) / (VSWR + 1)
- Geri dönüş kaybı RL = −20 log10 |Γ| dB,   uyumsuzluk kaybı ML = −10 log10 (1 − |Γ|²) dB
- Kompleks kaynak için güç dalgası Γ: |Γ| = |Zin − Zs*| / |Zin + Zs|
- Düğüm Q'su: Q = |X| / R ;   sabit-Q eğrileri: merkez (0, ±1/Q), yarıçap √(1 + 1/Q²)

## Smith diyagramı geometrisi (Γ düzlemi)
- sabit r çemberi: merkez (r/(1+r), 0), yarıçap 1/(1+r)
- sabit x yayı: merkez (1, 1/x), yarıçap 1/|x|
- admitans diyagramı = empedans diyagramının 180° döndürülmüşü (Γ_y = −Γ)
- seri L/C → sabit-r çemberi üzerinde hareket; paralel L/C → sabit-g çemberi üzerinde hareket;
  kayıpsız hat → merkez etrafında saat yönünde ("jeneratöre doğru") 2βℓ dönüş (λ/2 = tam tur)

## İletim hatları
- Zin = Z0 (ZL + Z0 tanh γℓ) / (Z0 + ZL tanh γℓ),  γ = α + jβ,  β = 2π f √εeff / c
- kayıpsız: Zin = Z0 (ZL + jZ0 tan βℓ) / (Z0 + jZL tan βℓ)
- açık uçlu stub: Z = −jZ0 cot βℓ ;  kısa devre stub: Z = jZ0 tan βℓ
- λ/4 trafo: Z1 = √(Z0 · RL) ;  λ/2 hat yükü aynen tekrarlar
- gerilim maksimumu yükten d_max = θΓ λ / 4π uzaklıkta, minimum λ/4 ötede

## L-devresi (reel Rs, RL; R_yüksek/R_düşük)
- Q = √(R_yüksek / R_düşük − 1),  X_seri = Q · R_düşük,  X_paralel = R_yüksek / Q
- Pi: sanal R = R_yüksek / (Q² + 1) ;  T: sanal R = R_düşük (Q² + 1)
- Eleman değerleri: L = X/ω, C = 1/(ωX);  paralel: C = B/ω, L = 1/(ω|B|)

## Tek stub (Pozar §5.2, paralel)
- t = [X_L ± √(R_L((Z0 − R_L)² + X_L²)/Z0)] / (R_L − Z0)   (R_L = Z0 ise t = −X_L/2Z0)
- d/λ = atan(t)/2π (t ≥ 0) veya (π + atan t)/2π (t < 0)
- B = [R_L² t − (Z0 − X_L t)(X_L + Z0 t)] / (Z0 [R_L² + (X_L + Z0 t)²])
- açık stub: ℓ/λ = atan(−B/Y0)/2π ;  kısa devre stub: ℓ/λ = atan(Y0/B)/2π  (mod λ/2)

## İki portlu amplifikatörler
- Δ = S11 S22 − S12 S21
- Rollett K = (1 − |S11|² − |S22|² + |Δ|²) / (2 |S12 S21|);  koşulsuz kararlılık ⇔ K > 1 ve |Δ| < 1
- μ = (1 − |S11|²) / (|S22 − Δ S11*| + |S12 S21|) > 1  ⇔ koşulsuz kararlı (tek koşullu test)
- Γin = S11 + S12 S21 ΓL / (1 − S22 ΓL),   Γout = S22 + S12 S21 ΓS / (1 − S11 ΓS)
- Yük kararlılık çemberi: C_L = (S22 − Δ S11*)* / (|S22|² − |Δ|²),  R_L = |S12 S21| / ||S22|² − |Δ|²|
- Kaynak kararlılık çemberi: C_S = (S11 − Δ S22*)* / (|S11|² − |Δ|²),  R_S = |S12 S21| / ||S11|² − |Δ|²|
- G_T = (1 − |ΓS|²)|S21|²(1 − |ΓL|²) / (|1 − ΓS Γin|² |1 − S22 ΓL|²)
- MSG = |S21| / |S12|,  MAG = G_T,max = MSG (K − √(K² − 1))
- Eşlenik eşleştirme: ΓS = [B1 − √(B1² − 4|C1|²)] / 2C1, B1 = 1 + |S11|² − |S22|² − |Δ|², C1 = S11 − Δ S22*  (ΓL benzer)
- Tek yönlü (unilateral): G_S,max = 1/(1 − |S11|²), U = |S12 S21 S11 S22| / ((1 − |S11|²)(1 − |S22|²)), hata 1/(1±U)²

## Gürültü
- F = Fmin + (4 rn |ΓS − Γopt|²) / ((1 − |ΓS|²) |1 + Γopt|²),  rn = Rn / Z0
- N = (F − Fmin) |1 + Γopt|² / (4 rn);  çember merkezi Γopt / (N + 1), yarıçap √(N(N + 1 − |Γopt|²)) / (N + 1)
`;

const COMPONENTS_EN = `# Circuit input format (analyze_circuit, render_smith_chart)

Circuits are a load plus a list of components **ordered from the load towards the source**.
Every value accepts engineering strings ("2.4GHz", "10nH", "1.5pF", "4k7") or SI numbers.

\`\`\`json
{
  "load": { "z": "25-j15" },
  "frequency": "2.4GHz",
  "z0": 50,
  "components": [
    { "type": "capacitor", "placement": "shunt",  "value": "1.2pF" },
    { "type": "inductor",  "placement": "series", "value": "3.3nH", "q": 40 },
    { "type": "transmission_line", "length": "0.125λ", "z0": 50, "eps_eff": 3.2 },
    { "type": "stub", "termination": "short", "placement": "shunt", "length": "12mm", "velocity_factor": 0.66 }
  ]
}
\`\`\`

| type | fields |
|---|---|
| inductor | placement, value, q?, esr?, tolerance_pct? |
| capacitor | placement, value, q?, esr?, esl?, tolerance_pct? |
| resistor | placement, value, esl?, tolerance_pct? |
| rlc | placement, arrangement (series/parallel), r?, l?, c? |
| impedance | placement, z or table [{f, re, im}], interpolation? |
| transmission_line | length, z0?, eps_eff? / velocity_factor?, loss_db_per_m? |
| stub | termination (open/short), placement? (shunt), length, z0?, eps_eff?, loss_db_per_m? |
| transformer | turns_ratio (Z_seen = N² · Z_load-side) |
| coupled_inductors | l_load, l_source, k |

Loads: \`{ "z": ... }\`, \`{ "gamma": {mag, angle_deg} }\`, \`{ "table": [{f, re, im}] }\`, or a measured
1-port \`{ "touchstone_path": "/abs/antenna.s1p" }\`.

Matching tools return \`components\` in this exact format, so results can be chained straight into
analyze_circuit and render_smith_chart.
`;

const COMPONENTS_TR = `# Devre giriş formatı (analyze_circuit, render_smith_chart)

Devre; bir yük ve **yükten kaynağa doğru sıralanmış** bileşen listesinden oluşur.
Tüm değerler mühendislik gösterimiyle ("2.4GHz", "10nH", "1.5pF", "4k7") ya da SI sayısı olarak verilebilir.

\`\`\`json
{
  "load": { "z": "25-j15" },
  "frequency": "2.4GHz",
  "z0": 50,
  "components": [
    { "type": "capacitor", "placement": "shunt",  "value": "1.2pF" },
    { "type": "inductor",  "placement": "series", "value": "3.3nH", "q": 40 },
    { "type": "transmission_line", "length": "0.125λ", "z0": 50, "eps_eff": 3.2 },
    { "type": "stub", "termination": "short", "placement": "shunt", "length": "12mm", "velocity_factor": 0.66 }
  ]
}
\`\`\`

| type | alanlar |
|---|---|
| inductor (bobin) | placement, value, q?, esr?, tolerance_pct? |
| capacitor (kondansatör) | placement, value, q?, esr?, esl?, tolerance_pct? |
| resistor (direnç) | placement, value, esl?, tolerance_pct? |
| rlc | placement, arrangement (series/parallel), r?, l?, c? |
| impedance | placement, z veya table [{f, re, im}], interpolation? |
| transmission_line (iletim hattı) | length, z0?, eps_eff? / velocity_factor?, loss_db_per_m? |
| stub | termination (open/short), placement? (shunt), length, z0?, eps_eff?, loss_db_per_m? |
| transformer (ideal trafo) | turns_ratio (görülen Z = N² · yük tarafı Z) |
| coupled_inductors (kuplajlı bobinler) | l_load, l_source, k |

placement: "series" = sinyal yoluna seri, "shunt" = sinyal yolundan toprağa (paralel).

Yükler: \`{ "z": ... }\`, \`{ "gamma": {mag, angle_deg} }\`, \`{ "table": [{f, re, im}] }\` ya da ölçülmüş
1 portlu \`{ "touchstone_path": "/mutlak/yol/anten.s1p" }\`.

Eşleştirme araçları \`components\` alanını tam olarak bu formatta döndürür; sonuçlar doğrudan
analyze_circuit ve render_smith_chart araçlarına aktarılabilir.
`;

// Example device data (public textbook / application-note values) for trying the amplifier tools.
const EXAMPLE_STABILITY_S2P = `! Example small-signal BJT S-parameters, 100 MHz – 2 GHz (potentially unstable at low frequency)
# MHz S MA R 50
100  0.72  -46    17.973 148.5  0.03  68.5  0.88  -23.6
200  0.612 -80.9  13.927 127.3  0.047 57.1  0.697 -37.6
400  0.497 -121.3 8.656  105    0.066 51.3  0.479 -47.6
600  0.456 -143.5 6.08   92.8   0.079 52.9  0.382 -50.5
800  0.44  -157.6 4.725  84.3   0.094 55.4  0.339 -51.8
1000 0.436 -167.5 3.864  77     0.11  56.8  0.323 -53.4
1200 0.434 -176.1 3.258  70.3   0.126 57.9  0.312 -55.8
1400 0.433 176.6  2.847  64.5   0.143 58.4  0.304 -58.3
1600 0.433 170.9  2.329  57.4   0.16  58.9  0.296 -62
1800 0.434 165    2.252  54.2   0.178 58.6  0.293 -65
2000 0.439 159.6  2.057  49.2   0.197 58.1  0.294 -68.1
`;

const EXAMPLE_LNA_S2P = `! Example LNA transistor at 1.4 GHz with noise parameters
# GHz S MA R 50
1.4 0.533 176.6 2.8 64.5 0.02 58.4 0.604 -58.3
! Noise parameters: freq NFmin(dB) |Gopt| angle(Gopt) Rn/Z0
1.4 1.6 0.5 130 0.4
`;

const DOCS: { name: string; uri: string; title: string; description: string; mimeType: string; text: string }[] = [
  { name: "formulas-en", uri: "smith://docs/formulas.en.md", title: "RF formula sheet (English)", description: "Smith chart, transmission-line, matching, stability, gain and noise formulas.", mimeType: "text/markdown", text: FORMULAS_EN },
  { name: "formulas-tr", uri: "smith://docs/formulas.tr.md", title: "RF formül kartı (Türkçe)", description: "Smith diyagramı, iletim hattı, eşleştirme, kararlılık, kazanç ve gürültü formülleri.", mimeType: "text/markdown", text: FORMULAS_TR },
  { name: "components-en", uri: "smith://docs/components.en.md", title: "Circuit input format (English)", description: "How to describe loads and components for analyze_circuit / render_smith_chart.", mimeType: "text/markdown", text: COMPONENTS_EN },
  { name: "components-tr", uri: "smith://docs/components.tr.md", title: "Devre giriş formatı (Türkçe)", description: "analyze_circuit / render_smith_chart için yük ve bileşen tanımı.", mimeType: "text/markdown", text: COMPONENTS_TR },
  { name: "changelog-en", uri: "smith://changelog.en.md", title: "Changelog (English)", description: "Release history: what changed in each version.", mimeType: "text/markdown", text: changelogMarkdown("en") },
  { name: "changelog-tr", uri: "smith://changelog.tr.md", title: "Değişiklik günlüğü (Türkçe)", description: "Sürüm geçmişi: her sürümde neler değişti.", mimeType: "text/markdown", text: changelogMarkdown("tr") },
  { name: "example-stability-s2p", uri: "smith://examples/bjt-100m-2g.s2p", title: "Example .s2p: BJT 100 MHz–2 GHz", description: "Multi-frequency 2-port data for stability / gain-circle experiments (use touchstone_content).", mimeType: "text/plain", text: EXAMPLE_STABILITY_S2P },
  { name: "example-lna-s2p", uri: "smith://examples/lna-1g4-noise.s2p", title: "Example .s2p with noise: LNA @ 1.4 GHz", description: "Single-frequency 2-port with a noise block for noise_circles (use touchstone_content).", mimeType: "text/plain", text: EXAMPLE_LNA_S2P },
];

export function registerResources(server: McpServer): void {
  for (const d of DOCS) {
    server.registerResource(d.name, d.uri, { title: d.title, description: d.description, mimeType: d.mimeType }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: d.mimeType, text: d.text }],
    }));
  }
}

export const RESOURCE_URIS = DOCS.map((d) => d.uri);
export const _examples = { EXAMPLE_STABILITY_S2P, EXAMPLE_LNA_S2P };
