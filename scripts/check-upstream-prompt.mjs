#!/usr/bin/env node
// Upstream pi system-prompt drift detector.
//
// Snapshots pi's DEFAULT system prompt. The local system-prompt extension
// intentionally replaces Pi's verbose documentation block with a concise pointer
// to the pi-development skill, but this baseline remains useful for reviewing
// upstream wording changes.
//
// The generated prompt uses deterministic inputs and redacts runtime-resolved
// documentation paths plus cwd before comparing to:
//   extensions/system-prompt/upstream-prompt.golden
//
// Implementation note: buildSystemPrompt is not exported from the package's
// public entry (only ".", "./rpc-entry", "./client"), so we import it by relative
// path from the installed dist. If pi restructures this file away, the script
// errors loudly — which is itself a drift signal to investigate.

import { readFileSync, writeFileSync, existsSync, unlinkSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(ROOT, "extensions/system-prompt/upstream-prompt.golden");
const TMP = join(ROOT, "extensions/system-prompt/.upstream-prompt.generated");
const UPDATE = process.argv.includes("--update");

// buildSystemPrompt lives at dist/core/system-prompt.js in the installed
// package. Prefer the repository's dev dependency; otherwise use the globally
// installed CLI package so the check still works in a setup without node_modules.
const LOCAL_MOD_PATH = join(
  ROOT,
  "node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
);
let globalModPath;
try {
  const cliPath = realpathSync(
    process.env.PI_CLI_PATH || execSync("command -v pi", { encoding: "utf8" }).trim(),
  );
  // The resolved CLI resides at <package>/dist/cli.js, beside dist/core/.
  globalModPath = join(dirname(cliPath), "core/system-prompt.js");
} catch {
  // Keep the local path in the error message when neither source is available.
}
const MOD_PATH = existsSync(LOCAL_MOD_PATH) ? LOCAL_MOD_PATH : globalModPath ?? LOCAL_MOD_PATH;
let buildSystemPrompt;
try {
  ({ buildSystemPrompt } = await import(MOD_PATH));
} catch (err) {
  console.error(
    `Cannot import pi's buildSystemPrompt from ${MOD_PATH}.\n` +
      `Install the repo dependencies with npm install, or pass PI_CLI_PATH=$(command -v pi).\n` +
      `Pi may also have restructured its dist layout (itself a drift signal).\n` +
      `Underlying error: ${err.message}`,
  );
  process.exit(1);
}

// Deterministic inputs: fixed tool snippets so the "Available tools" list is
// stable; no skills/context/append so only the FIXED parts pi emits appear.
// cwd is a fixed placeholder (redacted line below is already stable).
const prompt = buildSystemPrompt({
  selectedTools: ["read", "bash", "edit", "write"],
  toolSnippets: {
    read: "READ_SNIPPET",
    bash: "BASH_SNIPPET",
    edit: "EDIT_SNIPPET",
    write: "WRITE_SNIPPET",
  },
  cwd: "REDACTED_CWD",
  contextFiles: [],
  skills: [],
});

// Redact the three runtime-resolved absolute paths in the Pi-docs block so
// the snapshot is machine-independent.
const redacted =
  prompt
    .replace(/^- Main documentation: .+$/m, "- Main documentation: <REDACTED>")
    .replace(/^- Additional docs: .+$/m, "- Additional docs: <REDACTED>")
    .replace(
      /^- Examples: .+? \(extensions, custom tools, SDK\)$/m,
      "- Examples: <REDACTED> (extensions, custom tools, SDK)",
    ) + "\n";

if (UPDATE) {
  writeFileSync(GOLDEN, redacted);
  console.log(`Updated golden baseline: ${GOLDEN}`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  writeFileSync(GOLDEN, redacted);
  console.error(`Golden baseline was missing — created it: ${GOLDEN}`);
  console.error("Commit it and re-run.");
  process.exit(1);
}

const golden = readFileSync(GOLDEN, "utf8");
if (golden === redacted) {
  console.log("upstream system prompt: in sync with golden baseline ✓");
  // Clean up any stale generated file from a previous failed run.
  try {
    unlinkSync(TMP);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// Mismatch — write the generated snapshot and show a real diff.
writeFileSync(TMP, redacted);
console.error(
  "❌ upstream pi's default system prompt CHANGED and no longer matches the golden baseline.\n",
);
const r = spawnSync("git", ["diff", "--no-index", "--text", GOLDEN, TMP], { stdio: "inherit" });
// git diff --no-index exits 1 when files differ — expected here.
if (r.status !== 1 && r.status !== 0) {
  console.error(`(git diff exited ${r.status})`);
}
console.error(
  "\nIf this change is expected, update the baseline:\n" +
    "  node scripts/check-upstream-prompt.mjs --update\n" +
    "Then review whether skills/pi-development/SKILL.md or the local prompt pointer\n" +
    "also need to change, and re-run: npm run typecheck && npm run lint && npm test\n",
);
process.exit(1);
