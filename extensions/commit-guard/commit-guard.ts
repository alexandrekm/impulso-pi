/**
 * Commit-guard: enforce commitlint on every `git commit` the agent makes.
 *
 * A work-profile pi extension (mirrors command-guard's `tool_call` hook). On
 * every `bash` tool_call it looks for `git commit`, parses the message, and:
 *
 *   1. Blocks `--no-verify` / `-n` — those skip the repo's own pre-commit /
 *      commit-msg hooks. Fix the cause instead of bypassing it.
 *   2. Validates the message:
 *        - If the repo has a runnable commitlint
 *          (`node_modules/.bin/commitlint`), run it on the message (stdin) —
 *          exactly what CI does — and block on non-zero, surfacing its output.
 *        - Otherwise, fall back to the built-in Motive rules in `rules.ts`.
 *   3. `--amend` with a `-m` message is validated like any other commit.
 *      `--amend` without `-m` (reuses the prior message) is allowed through —
 *      there's no new message to lint; force-push is not blocked (a true
 *      pre-tool "warn" isn't expressible in the tool_call hook).
 *
 * The agent "always hits a tool": every commit goes through the bash tool,
 * which goes through this hook, so a non-compliant commit is blocked before it
 * is created — no CI round-trip, no history rewrite.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";
import { extractCommits, fullMessage, type CommitInfo } from "./parse.ts";
import { FORMAT_HINT, validateMessage } from "./rules.ts";

const COMMITLINT_CONFIG_HINTS = [
  "commitlint.config.js",
  "commitlint.config.ts",
  "commitlint.config.mjs",
  "commitlint.config.cjs",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
  ".commitlintrc.js",
  ".commitlintrc.ts",
];

function repoToplevel(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return undefined;
}

function commitlintConfigPresent(root: string): boolean {
  for (const f of COMMITLINT_CONFIG_HINTS) {
    if (existsSync(join(root, f))) return true;
  }
  try {
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      commitlint?: unknown;
    };
    if (pj && pj.commitlint) return true;
  } catch {
    // no package.json / not JSON — not present
  }
  return false;
}

/**
 * Run the repo's own commitlint on the message. Returns:
 *   { ok: true }            — message passes (or commitlint absent → caller
 *                             falls back to built-in rules)
 *   { ok: false, output }   — message fails; output is commitlint's report
 *   undefined               — no runnable commitlint; caller falls back
 */
function runCommitlint(
  root: string,
  message: string,
): { ok: true } | { ok: false; output: string } | undefined {
  const bin = join(root, "node_modules", ".bin", "commitlint");
  if (!existsSync(bin)) {
    // No runnable binary (deps not installed, or no commitlint at all)
    // → fall back to the built-in rules. We don't attempt `npx`, which
    // would either hit the network or fail with a confusing message.
    return undefined;
  }
  const r = spawnSync(bin, [], {
    input: message,
    encoding: "utf8",
    timeout: 15000,
    cwd: root,
  });
  if (r.error) return undefined; // binary crashed / not executable → fall back
  if (r.status === 0) return { ok: true };
  return { ok: false, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

function block(reason: string): { block: true; reason: string } {
  return { block: true, reason };
}

function validateOne(info: CommitInfo): { block: true; reason: string } | undefined {
  if (info.noVerify) {
    return block(
      "[commit-guard] `--no-verify` is blocked: it skips the repo's own " +
        "pre-commit / commit-msg hooks. Drop `--no-verify` and let the hooks " +
        "run; if a hook fails, fix the cause rather than bypassing it.",
    );
  }

  const message = fullMessage(info);
  if (!message.trim()) {
    // No `-m`/`-F` (e.g. `git commit --amend` reusing the prior message, a
    // merge commit, or `-e` editor commit) — nothing to lint; let it through.
    return undefined;
  }

  const root = repoToplevel();
  if (root) {
    const result = runCommitlint(root, message);
    if (result) {
      if (result.ok) return undefined;
      return block(
        `[commit-guard] commit message failed the repo's commitlint (this is what CI runs):\n${result.output.trim()}\n\nProposed message:\n${message.split(/\r?\n/)[0]}\n\nFix the message and retry.`,
      );
    }
  }

  // No runnable commitlint → built-in Motive rules.
  const v = validateMessage(message);
  if (v.ok) return undefined;
  const lines = v.violations.map((x) => `- [${x.rule}] ${x.message}`);
  // If the repo declares its own commitlint config but the binary isn't
  // installed, the built-in rules are a best-effort guess — flag it so the
  // user can `npm install` for exact CI parity.
  const parityNote =
    root && commitlintConfigPresent(root)
      ? "\n\nNote: this repo has a commitlint config but its deps aren't installed, so these are the built-in Motive rules, not the repo's exact rules — run `npm install` to validate against the real commitlint."
      : "";
  return block(
    `[commit-guard] commit message violates commitlint rules:\n${lines.join("\n")}\n\nProposed message:\n${message.split(/\r?\n/)[0]}\n\n${FORMAT_HINT}${parityNote}`,
  );
}

export default function (pi: any): void {
  if (!isFeatureEnabled("commit-guard")) return;

  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "bash") return undefined;
    const input = event.input as { command?: unknown } | undefined;
    const command = input && typeof input.command === "string" ? input.command : undefined;
    if (!command) return undefined;

    const commits = extractCommits(command);
    if (commits.length === 0) return undefined;

    for (const info of commits) {
      const blocked = validateOne(info);
      if (blocked) return blocked;
    }
    return undefined;
  });
}
