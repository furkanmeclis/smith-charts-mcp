/** Regenerates CHANGELOG.md from src/changelog.ts. Usage: npm run changelog */
import { writeFileSync } from "node:fs";

import { changelogMarkdown } from "../src/changelog.ts";

writeFileSync(new URL("../CHANGELOG.md", import.meta.url), changelogMarkdown("en"));
console.log("CHANGELOG.md updated");
