import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The factory gates on the impulso feature manifest, resolved at import time.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));

const {
  buildGuidelinesSection,
  buildPrompt,
  default: factory,
} = await import("./system-prompt.ts");

describe("buildGuidelinesSection", () => {
  test("adds the bash-only fileops guideline only when no search tool exists", () => {
    const withGuideline = buildGuidelinesSection({ promptGuidelines: [] }, ["bash"]);
    assert.match(withGuideline, /Use bash for file operations/);

    for (const tools of [
      ["bash", "grep"],
      ["bash", "find"],
      ["bash", "ls"],
      ["grep"],
      ["read", "edit"],
    ]) {
      assert.ok(!buildGuidelinesSection({ promptGuidelines: [] }, tools).includes("Use bash"));
    }
  });

  test("merges and dedupes tool guidelines with the output style", () => {
    const section = buildGuidelinesSection(
      { promptGuidelines: ["  Be concise in your responses  ", "custom guideline", ""] },
      ["bash"],
    );
    const lines = section.split("\n");
    assert.equal(lines.filter((l) => l.includes("Be concise")).length, 1); // deduped
    assert.ok(section.includes("- custom guideline"));
    assert.ok(section.includes("- Show file paths"));
    assert.ok(!section.includes("- -"));
  });

  test("emits the pi-development pointer only when that skill is model-visible", () => {
    const withSkill = buildGuidelinesSection(
      { promptGuidelines: [], skills: [{ name: "pi-development" }] },
      [],
    );
    assert.match(withSkill, /load the `pi-development` skill/);

    const hidden = buildGuidelinesSection(
      { promptGuidelines: [], skills: [{ name: "pi-development", disableModelInvocation: true }] },
      [],
    );
    assert.ok(!hidden.includes("pi-development"));

    const none = buildGuidelinesSection({ promptGuidelines: [], skills: [] }, []);
    assert.ok(!none.includes("pi-development"));
  });
});

describe("buildPrompt", () => {
  test("joins the fixed sections and lists only tools with snippets", () => {
    const prompt = buildPrompt({
      selectedTools: ["read", "bash", "ghost-tool"],
      toolSnippets: { read: "Read files", bash: "Run commands" },
      promptGuidelines: [],
      skills: [],
      cwd: "/tmp/x",
    });
    assert.match(prompt, /^You are an expert coding assistant/);
    assert.ok(prompt.includes("- read: Read files"));
    assert.ok(prompt.includes("- bash: Run commands"));
    assert.ok(!prompt.includes("ghost-tool"));
    assert.ok(prompt.includes("In addition to the tools above"));
    assert.match(prompt, /Current working directory: \/tmp\/x$/);
  });

  test("shows (none) when no tool has a snippet; default tools apply", () => {
    const prompt = buildPrompt({ toolSnippets: {}, promptGuidelines: [] });
    assert.ok(prompt.includes("Available tools:\n(none)"));
    // default selectedTools include read → skills section logic applies
    assert.ok(prompt.includes("Guidelines:"));
  });

  test("appendSystemPrompt: array joined, string kept, falsy dropped", () => {
    const asArray = buildPrompt({ appendSystemPrompt: ["one", "", "two"] });
    assert.ok(asArray.includes("one\n\ntwo"));

    const asString = buildPrompt({ appendSystemPrompt: "solo" });
    assert.ok(asString.includes("solo"));
  });

  test("contextFiles are wrapped in project_context blocks", () => {
    const prompt = buildPrompt({
      contextFiles: [{ path: "AGENTS.md", content: "be kind" }],
    });
    assert.ok(prompt.includes("<project_context>"));
    assert.ok(
      prompt.includes('<project_instructions path="AGENTS.md">\nbe kind\n</project_instructions>'),
    );
    assert.ok(prompt.includes("</project_context>"));
  });

  test("skills section requires the read tool and escapes XML", () => {
    const skills = [{ name: "a<b>", description: "d&d", filePath: "/x/y z.md" }];
    const withRead = buildPrompt({ selectedTools: ["read"], skills });
    assert.ok(withRead.includes("<available_skills>"));
    assert.ok(withRead.includes("<name>a&lt;b&gt;</name>"));
    assert.ok(withRead.includes("<description>d&amp;d</description>"));
    assert.ok(withRead.includes("<location>/x/y z.md</location>"));

    const withoutRead = buildPrompt({ selectedTools: ["bash"], skills });
    assert.ok(!withoutRead.includes("<available_skills>"));

    const hidden = buildPrompt({
      selectedTools: ["read"],
      skills: [{ name: "x", disableModelInvocation: true }],
    });
    assert.ok(!hidden.includes("<available_skills>"));
  });

  test("cwd backslashes become forward slashes", () => {
    assert.ok(buildPrompt({ cwd: "C:\\work\\repo" }).includes("C:/work/repo"));
  });
});

describe("factory before_agent_start hook", () => {
  function makePi() {
    const handlers = new Map<string, (event: unknown) => unknown>();
    factory({ on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h) });
    return handlers.get("before_agent_start")!;
  }

  test("rewrites the prompt from structured options", async () => {
    const h = makePi();
    const result = (await h({
      systemPromptOptions: { selectedTools: ["read"], toolSnippets: { read: "r" }, cwd: "/x" },
    })) as { systemPrompt: string };
    assert.ok(result.systemPrompt.includes("Available tools:"));
  });

  test("leaves the prompt alone without options or with a custom prompt", async () => {
    const h = makePi();
    assert.equal(await h({}), undefined);
    assert.equal(await h({ systemPromptOptions: { customPrompt: "mine" } }), undefined);
  });
});
