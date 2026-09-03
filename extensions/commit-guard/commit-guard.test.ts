import assert from "node:assert/strict";
import { describe, test } from "node:test";

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
