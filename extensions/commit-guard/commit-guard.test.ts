import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { extractCommits, fullMessage, tokenize, type CommitInfo } from "./parse.ts";
import { FORMAT_HINT, isIgnored, validateMessage } from "./rules.ts";

describe("tokenize", () => {
  test("unquotes single and double segments", () => {
    assert.deepEqual(tokenize(`git commit -m 'feat(AICPE-1): x'`), [
      "git",
      "commit",
      "-m",
      "feat(AICPE-1): x",
    ]);
    assert.deepEqual(tokenize(`git commit -m "feat(AICPE-1): x"`), [
      "git",
      "commit",
      "-m",
      "feat(AICPE-1): x",
    ]);
  });
  test("honors backslash escapes inside double quotes", () => {
    assert.deepEqual(tokenize(`echo "a\\"b"`), ["echo", `a"b`]);
  });
  test("handles -m attached to the message with no space", () => {
    assert.deepEqual(tokenize(`git commit -m"feat(AICPE-1): x"`), [
      "git",
      "commit",
      "-mfeat(AICPE-1): x",
    ]);
  });

  test("preserves empty quoted tokens (regression for PR #73 review)", () => {
    // `git commit -m "" file.txt`: `-m` takes the empty string, `file.txt`
    // is a pathspec — not the message.
    assert.deepEqual(tokenize(`git commit -m "" file.txt`), [
      "git",
      "commit",
      "-m",
      "",
      "file.txt",
    ]);
    assert.deepEqual(tokenize(`git commit -m ''`), ["git", "commit", "-m", ""]);
    const info = extractCommits(`git commit -m "" file.txt`)[0];
    assert.deepEqual(info.messages, [""]);
  });
});

function commit(cmd: string): CommitInfo | undefined {
  const infos = extractCommits(cmd);
  return infos[0];
}

describe("extractCommits", () => {
  test("detects a plain git commit -m", () => {
    const info = commit(`git commit -m "feat(AICPE-107): add xgboost model"`);
    assert.ok(info);
    assert.equal(info!.messages.join("|"), "feat(AICPE-107): add xgboost model");
    assert.equal(info!.noVerify, false);
    assert.equal(info!.amend, false);
  });

  test("peels cd && wrapper", () => {
    const info = commit(`cd repo && git commit -m "feat(AICPE-107): add thing"`);
    assert.ok(info);
    assert.equal(info!.messages[0], "feat(AICPE-107): add thing");
  });

  test("peels bash -c wrapper", () => {
    const info = commit(`bash -c "git commit -m 'fix(AICPE-2): patch leak'"`);
    assert.ok(info);
    assert.equal(info!.messages[0], "fix(AICPE-2): patch leak");
  });

  test("flags --no-verify and -n", () => {
    assert.equal(commit(`git commit --no-verify -m "feat(AICPE-1): x"`)!.noVerify, true);
    assert.equal(commit(`git commit -n -m "feat(AICPE-1): x"`)!.noVerify, true);
  });

  test("flags --amend", () => {
    assert.equal(commit(`git commit --amend -m "feat(AICPE-1): redo"`)!.amend, true);
  });

  test("handles --message= and -m attached forms", () => {
    assert.equal(
      commit(`git commit --message="feat(AICPE-1): x"`)!.messages[0],
      "feat(AICPE-1): x",
    );
    assert.equal(commit(`git commit -m"feat(AICPE-1): x"`)!.messages[0], "feat(AICPE-1): x");
    // Bare `-mfeat(AICPE-1): x` (unquoted, with a space) matches git: `-m`
    // takes `feat(AICPE-1):` and `x` becomes a pathspec.
    assert.equal(commit(`git commit -mfeat(AICPE-1): x`)!.messages[0], "feat(AICPE-1):");
  });

  test("joins multiple -m as paragraphs", () => {
    const info = commit(`git commit -m "feat(AICPE-1): x" -m "body line"`);
    assert.ok(info);
    assert.equal(fullMessage(info!), "feat(AICPE-1): x\n\nbody line");
  });

  test("ignores git -C global passthrough", () => {
    const info = commit(`git -C path commit -m "feat(AICPE-1): x"`);
    assert.ok(info);
    assert.equal(info!.messages[0], "feat(AICPE-1): x");
  });

  test("returns nothing for non-commit commands", () => {
    assert.equal(extractCommits(`git push`).length, 0);
    assert.equal(extractCommits(`ls -la`).length, 0);
    assert.equal(extractCommits(`git status`).length, 0);
  });

  test("finds a commit in a && chain", () => {
    const infos = extractCommits(`npm test && git commit -m "ci(AICPE-1): lint"`);
    assert.equal(infos.length, 1);
    assert.equal(infos[0].messages[0], "ci(AICPE-1): lint");
  });
});

describe("validateMessage (built-in rules)", () => {
  test("accepts a conforming message", () => {
    const r = validateMessage("feat(AICPE-107): add xgboost model for sbv cbb");
    assert.equal(r.ok, true);
  });

  test("accepts a cherry-pick suffix", () => {
    const r = validateMessage("feat(AICPE-107): add thing (#30614)");
    assert.equal(r.ok, true);
  });

  test("rejects chore", () => {
    const r = validateMessage("chore(AICPE-1): tidy up");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "type-enum"));
  });

  test("rejects missing scope", () => {
    const r = validateMessage("feat: add thing");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "scope-empty"));
  });

  test("rejects a non-Jira scope", () => {
    const r = validateMessage("feat(api): add thing");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "valid-jira-scope"));
  });

  test("rejects a trailing full stop", () => {
    const r = validateMessage("feat(AICPE-1): add thing.");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "subject-full-stop"));
  });

  test("rejects special chars in subject (colon)", () => {
    const r = validateMessage("feat(AICPE-1): add x: y");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "no-special-chars-in-subject"));
  });

  test("rejects special chars in subject (backticks/brackets)", () => {
    const r = validateMessage("feat(AICPE-1): use `foo` [bar]");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "no-special-chars-in-subject"));
  });

  test("rejects an over-long header", () => {
    const r = validateMessage("feat(AICPE-1): " + "x".repeat(210));
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "header-max-length"));
  });

  test("skips the 'initial plan' placeholder", () => {
    assert.equal(isIgnored("initial plan"), true);
    assert.equal(isIgnored("Initial Plan"), true);
    assert.equal(validateMessage("initial plan").ok, true);
  });

  test("FORMAT_HINT is a non-empty string", () => {
    assert.ok(FORMAT_HINT.length > 0);
  });
});

describe("message-file options", () => {
  test("-F / --file / -F<file> read the message from a file", () => {
    const dir = mkdtempSync(join(process.cwd(), ".commit-guard-test-"));
    try {
      const file = join(dir, "msg.txt");
      writeFileSync(file, "feat(AICPE-1): from file");
      assert.equal(commit(`git commit -F "${file}"`)!.messages[0], "feat(AICPE-1): from file");
      assert.equal(commit(`git commit --file=${file}`)!.messages[0], "feat(AICPE-1): from file");
      assert.equal(commit(`git commit -F${file}`)!.messages[0], "feat(AICPE-1): from file");
      assert.equal(commit(`git commit --file "${file}"`)!.messages[0], "feat(AICPE-1): from file");
      // Relative path resolves against cwd (the repo root under npm test).
      const rel = relative(process.cwd(), file);
      assert.equal(commit(`git commit -F "${rel}"`)!.messages[0], "feat(AICPE-1): from file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("-F on a missing file yields an empty message, not an error", () => {
    const info = commit(`git commit -F /nonexistent-$$-${Date.now()}/msg.txt`);
    assert.ok(info);
    assert.deepEqual(info!.messages, [""]);
  });
});

describe("parseOne edge cases", () => {
  test("empty and whitespace-only input yields no commits", () => {
    assert.equal(extractCommits("").length, 0);
    assert.equal(extractCommits("   ").length, 0);
  });
  test("full path to the git binary is recognized", () => {
    assert.equal(
      commit(`/usr/bin/git commit -m "feat(AICPE-1): via path"`)!.messages[0],
      "feat(AICPE-1): via path",
    );
  });
  test("-- stops option parsing: later -m is a pathspec, not a message", () => {
    const info = commit(`git commit -- -m "feat(AICPE-1): x"`);
    assert.ok(info);
    assert.deepEqual(info!.messages, []);
  });
  test("unterminated quotes tokenize to end of input", () => {
    assert.deepEqual(tokenize(`git commit -m 'unterminated`), [
      "git",
      "commit",
      "-m",
      "unterminated",
    ]);
    assert.deepEqual(tokenize(`git commit -m "unterminated`), [
      "git",
      "commit",
      "-m",
      "unterminated",
    ]);
  });
});

describe("validateMessage line-length and format rules", () => {
  test("rejects an over-long body line", () => {
    const r = validateMessage(`feat(AICPE-1): ok\n\n${"y".repeat(210)}`);
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "body-max-line-length"));
  });

  test("rejects an over-long BREAKING CHANGE footer line", () => {
    const r = validateMessage(`feat(AICPE-1): ok\n\nBREAKING CHANGE: ${"z".repeat(210)}`);
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "footer-max-line-length"));
  });

  test("rejects a header that does not match type(scope): subject", () => {
    const r = validateMessage("not a commit header at all");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "type-empty"));

    const r2 = validateMessage("");
    assert.equal(r2.ok, false);
    assert.ok(r2.ok === false && r2.violations.some((v) => v.rule === "type-empty"));
  });

  test("rejects a whitespace-only subject", () => {
    const r = validateMessage("feat(AICPE-1):  ");
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.violations.some((v) => v.rule === "subject-empty"));
  });
});

// ── entry-file unit tests ──────────────────────────────────────────────────
// The factory + validateOne live in commit-guard.ts and need the feature
// manifest, so point PI_CODING_AGENT_DIR at a fresh temp dir BEFORE importing
// the module (the config dir is resolved at import time).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));

const {
  commitlintConfigPresent,
  runCommitlint,
  validateOne,
  default: factory,
} = await import("./commit-guard.ts");

describe("commitlintConfigPresent", () => {
  test("detects a commitlintrc file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-cfg-"));
    try {
      writeFileSync(join(dir, ".commitlintrc.json"), "{}");
      assert.equal(commitlintConfigPresent(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("detects a commitlint key in package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-cfg-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ commitlint: { extends: [] } }));
      assert.equal(commitlintConfigPresent(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a package.json without commitlint is not a config", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-cfg-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      assert.equal(commitlintConfigPresent(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("no package.json at all is not a config", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-cfg-"));
    try {
      assert.equal(commitlintConfigPresent(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runCommitlint", () => {
  const fakeBin = (dir: string, body: string, executable = true) => {
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "commitlint");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, executable ? 0o755 : 0o644);
    return dir;
  };

  test("no binary → undefined (caller falls back to built-in rules)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-run-"));
    try {
      assert.equal(runCommitlint(dir, "feat(AICPE-1): x"), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("passing binary → ok", () => {
    const dir = fakeBin(mkdtempSync(join(tmpdir(), "cg-run-")), "exit 0");
    try {
      assert.deepEqual(runCommitlint(dir, "feat(AICPE-1): x"), { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("failing binary → ok:false with the report", () => {
    const dir = fakeBin(
      mkdtempSync(join(tmpdir(), "cg-run-")),
      'echo "✖ subject may not be empty" >&2; exit 1',
    );
    try {
      const r = runCommitlint(dir, "bad");
      assert.ok(r && r.ok === false);
      assert.match((r as { output: string }).output, /subject may not be empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("crashed / non-executable binary → undefined", () => {
    const dir = fakeBin(mkdtempSync(join(tmpdir(), "cg-run-")), "exit 0", false);
    try {
      assert.equal(runCommitlint(dir, "feat(AICPE-1): x"), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateOne", () => {
  test("blocks --no-verify", () => {
    const r = validateOne({ messages: ["feat(AICPE-1): x"], noVerify: true, amend: false });
    assert.ok(r?.block);
    assert.match(r!.reason, /--no-verify/);
  });
  test("commits with no message (amend/merge/editor) pass through", () => {
    assert.equal(validateOne({ messages: [], noVerify: false, amend: true }), undefined);
  });
  test("blocks a message violating the built-in Motive rules", () => {
    // This repo has no runnable commitlint, so validateOne uses the built-ins.
    const r = validateOne({ messages: ["chore: no jira scope"], noVerify: false, amend: false });
    assert.ok(r?.block);
    assert.match(r!.reason, /commitlint rules/);
  });
  test("passes a compliant message", () => {
    assert.equal(
      validateOne({ messages: ["feat(AICPE-1): add thing"], noVerify: false, amend: false }),
      undefined,
    );
  });
});

describe("factory tool_call hook", () => {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  factory({ on: (name: string, h: (event: unknown) => Promise<unknown>) => handlers.set(name, h) });
  const hook = handlers.get("tool_call")!;

  test("ignores non-bash tools and non-commit commands", async () => {
    assert.equal(await hook({ toolName: "read", input: { file_path: "x" } }), undefined);
    assert.equal(await hook({ toolName: "bash", input: { command: "git status" } }), undefined);
  });
  test("ignores bash calls without a command string", async () => {
    assert.equal(await hook({ toolName: "bash", input: {} }), undefined);
    assert.equal(await hook({ toolName: "bash" }), undefined);
  });
  test("blocks a violating git commit", async () => {
    const r = await hook({ toolName: "bash", input: { command: `git commit -m "chore: bad"` } });
    assert.ok(r && (r as { block: boolean }).block);
  });
  test("lets a compliant git commit through", async () => {
    const r = await hook({
      toolName: "bash",
      input: { command: `git commit -m "feat(AICPE-1): fine"` },
    });
    assert.equal(r, undefined);
  });
});
