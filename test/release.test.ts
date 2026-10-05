import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CHANGELOG, changelogMarkdown, compareVersions } from "../src/changelog.ts";
import { VERSION } from "../src/version.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("release consistency", () => {
  it("package.json, src/version.ts, server.json and the changelog agree on the version", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const srv = JSON.parse(read("server.json")) as { version: string; packages: { version: string }[] };
    assert.equal(VERSION, pkg.version);
    assert.equal(srv.version, pkg.version);
    for (const p of srv.packages) assert.equal(p.version, pkg.version);
    assert.equal(CHANGELOG[0].version, pkg.version, "add a changelog entry for the new version");
  });
  it("changelog is newest-first, dated and unique", () => {
    for (let i = 1; i < CHANGELOG.length; i++) assert.ok(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version) > 0);
    for (const e of CHANGELOG) assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  });
  it("CHANGELOG.md is generated from src/changelog.ts (run npm run changelog)", () => {
    assert.equal(read("CHANGELOG.md"), changelogMarkdown("en"));
  });
});
