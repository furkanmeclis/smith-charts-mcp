import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerPrompts } from "./prompts/index.ts";
import { registerResources } from "./resources/index.ts";
import { registerAmplifierTools } from "./tools/amplifier.ts";
import { registerCircuitTools } from "./tools/circuit.ts";
import { registerConvertTools } from "./tools/convert.ts";
import { registerMatchingTools } from "./tools/matching.ts";
import { registerRenderTool } from "./tools/render.ts";
import { registerVersionTool } from "./tools/version.ts";
import { VERSION } from "./version.ts";

export const SERVER_NAME = "smith-charts-mcp";

const INSTRUCTIONS = `smith-charts-mcp: RF & microwave engineering toolkit built around the Smith chart.
- Values accept engineering notation ("2.4GHz", "10nH", "1.5pF", "25-j15", "0.25λ", "45deg", "12mm").
- Circuits are listed from the LOAD towards the SOURCE; placement "series" or "shunt".
- Matching tools (design_l_match, design_pi_t_match, design_stub_match, design_quarter_wave) return "components"
  that can be passed unchanged to analyze_circuit and render_smith_chart — design, verify, then plot.
- Amplifier work: parse_touchstone → amplifier_stability → gain_circles / noise_circles / conjugate_match.
- Every tool takes language: "en" | "tr" for the human-readable summary; numeric JSON is always included.
- Reference sheets: smith://docs/formulas.en.md, smith://docs/components.en.md (Turkish: *.tr.md).
- Ask version_info (or read smith://changelog.en.md) for the running version and what changed between releases.`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Smith Charts MCP", version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  registerConvertTools(server);
  registerCircuitTools(server);
  registerMatchingTools(server);
  registerAmplifierTools(server);
  registerRenderTool(server);
  registerVersionTool(server);
  registerPrompts(server);
  registerResources(server);
  return server;
}
