import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// PI_CODING_AGENT_DIR points at a throwaway dir so the feature-flag check
// (impulso-settings.json) never reads the real profile. ./config.json (repo)
// supplies the real gating table: modes ["code","doc"], gated gws-docs-authoring
// (doc) and jira/jira-authoring/commit (code). Mode state is in-memory.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const { formatSkillsBlock, rewriteSkillsBlocks, default: factory } = await import("./index.ts");

describe("formatSkillsBlock", () => {
  test("empty when nothing is visible", () => {
    assert.equal(formatSkillsBlock([]), "");
    assert.equal(formatSkillsBlock([{ name: "x", disableModelInvocation: true }]), "");
    assert.equal(formatSkillsBlock(null as never), "");
  });

  test("renders visible skills; location only when filePath set", () => {
    const block = formatSkillsBlock([
      { name: "a&b", description: "d<c>", filePath: "/p q.md" },
      { name: "no-path", description: "" },
      { name: "hidden", disableModelInvocation: true },
    ]);
    assert.ok(block.includes("<available_skills>"));
    assert.ok(block.includes("<name>a&amp;b</name>"));
    assert.ok(block.includes("<description>d&lt;c&gt;</description>"));
    assert.ok(block.includes("<location>/p q.md</location>"));
    assert.ok(block.includes("<name>no-path</name>"));
    assert.ok(!block.includes("<location></location>"));
    assert.ok(!block.includes("hidden"));
    assert.ok(block.endsWith("</available_skills>"));
  });
});

describe("rewriteSkillsBlocks", () => {
  const one = (name: string, hidden = false) => ({
    name,
    description: "d",
    filePath: "/x.md",
    disableModelInvocation: hidden,
  });

  test("first block is rewritten in place, later duplicates removed", () => {
    const prompt =
      "intro\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool.\n\n<available_skills>\n  <skill>old</skill>\n</available_skills>\n\nmid\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool.\n\n<available_skills>\n  <skill>dup</skill>\n</available_skills>\n\ncwd line";
    const out = rewriteSkillsBlocks(prompt, [one("kept")]);
    assert.equal((out.match(/<available_skills>/g) ?? []).length, 1);
    assert.ok(out.includes("<name>kept</name>"));
    assert.ok(out.includes("intro"));
    assert.ok(out.includes("cwd line"));
    assert.ok(!out.includes("dup"));
  });

  test("all blocks removed when no skills remain visible", () => {
    const prompt =
      "x\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool.\n\n<available_skills>\n  <skill>old</skill>\n</available_skills>\n";
    const out = rewriteSkillsBlocks(prompt, [one("hidden", true)]);
    assert.ok(!out.includes("<available_skills>"));
  });

  test("prompt without a skills block is untouched", () => {
    assert.equal(rewriteSkillsBlocks("plain", [one("a")]), "plain");
  });
});

describe("factory", () => {
  function makePi() {
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
    const commands = new Map<
      string,
      {
        getArgumentCompletions: (p: string) => unknown;
        handler: (args: string, ctx: never) => Promise<void>;
      }
    >();
    const emitted: { channel: string; data: unknown }[] = [];
    factory({
      on: (n: string, h: (e: unknown, c?: unknown) => unknown) => handlers.set(n, h),
      registerCommand: (n: string, d: never) => commands.set(n, d),
      events: {
        emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
        on: () => {},
      },
    });
    return { handlers, commands, emitted };
  }

  const notifySpy = () => {
    const calls: { msg: string; level: string }[] = [];
    return { calls, ui: { notify: (msg: string, level: string) => calls.push({ msg, level }) } };
  };

  test("session_start resets a non-default mode to the default and broadcasts it", async () => {
    const { handlers, commands, emitted } = makePi();
    const { ui } = notifySpy();
    await commands.get("mode")!.handler("doc", { ui } as never); // → doc
    assert.deepEqual(emitted.at(-1), { channel: "modes:changed", data: { mode: "doc" } });

    await handlers.get("session_start")!({});
    assert.deepEqual(emitted.at(-1), { channel: "modes:changed", data: { mode: "code" } });

    const spy = notifySpy();
    await commands.get("mode")!.handler("status", { ui: spy.ui } as never);
    assert.match(spy.calls.at(-1)!.msg, /Current mode: code/);
  });

  test("before_agent_start gates skills per mode and rewrites the prompt block", async () => {
    const { handlers, commands } = makePi();
    const h = handlers.get("before_agent_start")!;
    const { ui } = notifySpy();
    await handlers.get("session_start")!({}); // clean slate: code
    await commands.get("mode")!.handler("doc", { ui } as never); // → doc
    const skills: {
      name: string;
      description: string;
      filePath: string;
      disableModelInvocation?: boolean;
    }[] = [
      { name: "jira", description: "d", filePath: "/j.md" },
      { name: "gws-docs-authoring", description: "d", filePath: "/g.md" },
      { name: "always-visible", description: "d", filePath: "/a.md" },
    ];
    const prompt =
      "The following skills provide specialized instructions for specific tasks.\nUse the read tool.\n\n<available_skills>\n  <skill>old</skill>\n</available_skills>\n";
    const result = (await h({ systemPromptOptions: { skills }, systemPrompt: prompt })) as {
      systemPrompt: string;
    };
    // doc mode: jira hidden, gws-docs-authoring visible
    assert.equal(skills[0]!.disableModelInvocation, true);
    assert.notEqual(skills[1]!.disableModelInvocation, true);
    assert.notEqual(skills[2]!.disableModelInvocation, true);
    assert.ok(result.systemPrompt.includes("<name>gws-docs-authoring</name>"));
    assert.ok(!result.systemPrompt.includes("<name>jira</name>"));

    // No skills block in the prompt → no rewrite result at all.
    assert.equal(
      await h({ systemPromptOptions: { skills: [] }, systemPrompt: "plain" }),
      undefined,
    );
  });

  test("/mode handler: status, toggle, explicit, invalid", async () => {
    const { commands, handlers, emitted } = makePi();
    const cmd = commands.get("mode")!;
    const { calls, ui } = notifySpy();
    await handlers.get("session_start")!({}); // clean slate: code

    await cmd.handler("status", { ui } as never);
    assert.match(calls.at(-1)!.msg, /Current mode: code/);
    assert.match(calls.at(-1)!.msg, /hidden: gws-docs-authoring/);

    await cmd.handler("toggle", { ui } as never); // code → doc
    assert.match(calls.at(-1)!.msg, /Mode: doc/);
    assert.deepEqual(emitted.at(-1), { channel: "modes:changed", data: { mode: "doc" } });

    await cmd.handler("code", { ui } as never);
    assert.deepEqual(emitted.at(-1), { channel: "modes:changed", data: { mode: "code" } });

    await cmd.handler("", { ui } as never); // bare = toggle → doc
    assert.deepEqual(emitted.at(-1), { channel: "modes:changed", data: { mode: "doc" } });

    await cmd.handler("bogus", { ui } as never);
    assert.match(calls.at(-1)!.msg, /Usage: \/mode/);
    // invalid action: no state change, no new broadcast
    assert.deepEqual(emitted.at(-1), { channel: "modes:changed", data: { mode: "doc" } });
  });

  test("argument completions filter by prefix", () => {
    const { commands } = makePi();
    const complete = commands.get("mode")!.getArgumentCompletions;
    const all = complete("") as { value: string }[];
    assert.deepEqual(all.map((o) => o.value).sort(), ["code", "doc", "status", "toggle"]);
    const d = complete("d") as { value: string }[];
    assert.deepEqual(
      d.map((o) => o.value),
      ["doc"],
    );
    assert.equal(complete("zzz"), null);
  });
});
