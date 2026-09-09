import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The handler resolves <configDir>/skills at import time; the trigger table
// comes from the repo's ./config.json (datadog / glean / scout).
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

// Install fake "datadog" and "glean" skills; leave "scout" uninstalled.
const installSkill = (name: string) => {
  mkdirSync(join(CONFIG_DIR, "skills", name), { recursive: true });
  writeFileSync(join(CONFIG_DIR, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
};
installSkill("datadog");
installSkill("glean");

const { buildMatcher, default: factory } = await import("./index.ts");

describe("buildMatcher", () => {
  test("matches whole words, case-insensitively, with optional plural s", () => {
    const m = buildMatcher(["metric", "SLO "])!;
    assert.ok(m.test("check the Metrics dashboard"));
    assert.ok(m.test("what's our slo"));
    assert.ok(m.test("SLOs are burning"));
    assert.ok(!m.test("check the params")); // word boundary, not substring
    assert.equal(buildMatcher([]), null);
    assert.equal(buildMatcher(["", "  "]), null);
  });

  test("regex metacharacters in keywords are escaped", () => {
    const m = buildMatcher(["a.b*c"])!;
    assert.ok(m.test("a.b*c"));
    assert.ok(!m.test("axbxc"));
  });
});

describe("input handler", () => {
  function makePi() {
    const handlers = new Map<string, (event: unknown) => unknown>();
    factory({ on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h) });
    return handlers.get("input")!;
  }

  test("appends a <skill_hint> block for installed, matching skills", async () => {
    const h = makePi();
    const result = (await h({ text: "please check the datadog dashboards" })) as {
      action: string;
      text: string;
    };
    assert.equal(result.action, "transform");
    assert.match(result.text, /^please check the datadog dashboards\n\n<skill_hint>/);
    assert.ok(result.text.includes(join(CONFIG_DIR, "skills", "datadog", "SKILL.md")));
    assert.ok(result.text.endsWith("</skill_hint>"));
  });

  test("non-matching text, slash commands, and junk events pass through", async () => {
    const h = makePi();
    assert.equal(await h({ text: "nothing relevant here" }), undefined);
    assert.equal(await h({ text: "/skill:datadog help" }), undefined);
    assert.equal(await h({ text: "" }), undefined);
    assert.equal(await h({}), undefined);
    assert.equal(await h("junk"), undefined);
  });

  test("uninstalled skills are skipped silently; multiple hints stack", async () => {
    const h = makePi();
    // "scout" trigger matches but the skill isn't installed on this profile.
    const onlyScout = (await h({ text: "run scout recon on the repo" })) as undefined;
    assert.equal(onlyScout, undefined);

    // datadog + glean both match and are installed → two hints in one block.
    const result = (await h({ text: "look in glean for the datadog slo" })) as { text: string };
    const block = result.text.split("<skill_hint>\n")[1]!;
    assert.ok(block.includes("Datadog skill"));
    assert.ok(block.includes("Glean skill"));
  });
});
