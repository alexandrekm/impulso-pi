import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Doc-mode state arrives via the modes extension's pi.events broadcasts
// (faked below with an in-memory bus); nothing is read from disk.
const { unquote, parseSkill, default: factory } = await import("./index.ts");

const writeSkill = (dir: string, body: string) => {
  mkdirSync(join(dir, "a-skill"), { recursive: true });
  writeFileSync(join(dir, "a-skill", "SKILL.md"), body);
};

describe("unquote", () => {
  test("strips matching surrounding quotes, keeps everything else", () => {
    assert.equal(unquote(` "quoted" `), "quoted");
    assert.equal(unquote(` 'single' `), "single");
    assert.equal(unquote(" plain "), "plain");
    assert.equal(unquote(` "mixed' `), "\"mixed'");
    assert.equal(unquote(""), "");
  });
});

describe("parseSkill", () => {
  test("parses a well-formed frontmatter block", () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-skill-"));
    try {
      writeSkill(
        dir,
        '---\nname: my-skill\ndescription: "does things"\nother: ignored\n---\n# Body\n',
      );
      const parsed = parseSkill("a-skill", dir);
      assert.ok(parsed);
      assert.equal(parsed!.name, "my-skill");
      assert.equal(parsed!.description, "does things");
      assert.equal(parsed!.filePath, join(dir, "a-skill", "SKILL.md"));
      assert.equal(parsed!.baseDir, join(dir, "a-skill"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("null for missing file, missing frontmatter fence, or missing fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-skill-"));
    try {
      assert.equal(parseSkill("no-such-skill", dir), null); // missing file

      writeSkill(dir, "no fence\nname: x\ndescription: y\n");
      assert.equal(parseSkill("a-skill", dir), null); // doesn't start with ---

      writeSkill(dir, "---\nname: x\ndescription: y\n"); // no closing ---
      assert.equal(parseSkill("a-skill", dir), null);

      writeSkill(dir, "---\nname: x\n---\n"); // no description
      assert.equal(parseSkill("a-skill", dir), null);

      writeSkill(dir, "---\ndescription: y\n---\n"); // no name
      assert.equal(parseSkill("a-skill", dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("first name/description wins over later duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-skill-"));
    try {
      writeSkill(dir, "---\nname: first\nname: second\ndescription: d1\ndescription: d2\n---\n");
      const parsed = parseSkill("a-skill", dir);
      assert.equal(parsed!.name, "first");
      assert.equal(parsed!.description, "d1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real vendored gws-shared skill parses", () => {
    const parsed = parseSkill("gws-shared");
    assert.ok(parsed);
    assert.equal(parsed!.name, "gws-shared");
    assert.ok(parsed!.description.length > 0);
  });
});

describe("factory before_agent_start hook", () => {
  function makePi() {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const bus: ((data: unknown) => void)[] = [];
    factory({
      on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h),
      events: {
        on: (_channel: string, h: (data: unknown) => void) => bus.push(h),
        emit: () => {},
      },
    });
    return {
      handler: handlers.get("before_agent_start")!,
      broadcast: (data: unknown) => {
        for (const h of bus) h(data);
      },
    };
  }

  test("doc mode injects skills into opts.skills and appends the block", async () => {
    const { handler: h, broadcast } = makePi();
    broadcast({ mode: "doc" });
    const opts = { skills: [{ name: "existing" }] };
    const result = (await h({ systemPromptOptions: opts, systemPrompt: "BASE" })) as {
      systemPrompt: string;
    };
    assert.match(result.systemPrompt, /^BASE\n\nThe following skills/);
    assert.ok(result.systemPrompt.includes("<available_skills>"));
    assert.ok(result.systemPrompt.includes("<name>gws-shared</name>"));
    // structured options gained the gws skills, existing one untouched
    const names = opts.skills.map((s: { name: string }) => s.name);
    assert.ok(names.includes("existing"));
    assert.ok(names.includes("gws-docs"));

    // Second run with the same opts: no duplicates.
    await h({ systemPromptOptions: opts, systemPrompt: "BASE2" });
    const again = opts.skills.filter((s: { name: string }) => s.name === "gws-docs").length;
    assert.equal(again, 1);
  });

  test("non-doc mode (or no modes extension) is inert; opts without a skills array only appends", async () => {
    const { handler: h, broadcast } = makePi();
    // No broadcast at all (modes extension absent) → inert.
    assert.equal(await h({ systemPromptOptions: {}, systemPrompt: "X" }), undefined);
    // Malformed broadcast → still inert.
    broadcast(undefined);
    assert.equal(await h({ systemPromptOptions: {}, systemPrompt: "X" }), undefined);
    broadcast({ mode: "code" });
    assert.equal(await h({ systemPromptOptions: {}, systemPrompt: "X" }), undefined);

    broadcast({ mode: "doc" });
    const result = (await h({ systemPromptOptions: {}, systemPrompt: "Y" })) as {
      systemPrompt: string;
    };
    assert.ok(result.systemPrompt.includes("gws-shared"));

    // Switching back to code turns injection off again.
    broadcast({ mode: "code" });
    assert.equal(await h({ systemPromptOptions: {}, systemPrompt: "Z" }), undefined);
  });
});
