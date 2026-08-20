#!/usr/bin/env node
// Upstream pi system-prompt drift detector.
//
// impulso-pi owns the FIXED parts of pi's system prompt in
// extensions/system-prompt/system-prompt.ts (intro, tools-footer line,
// always-on guidelines, Pi-docs block prose). The DYNAMIC parts (active
// tools, tool-contributed guidelines, --append-system-prompt, project
// context, skills, cwd) flow from pi. To stay in sync with upstream, this
// script snapshots pi's DEFAULT system prompt (built with deterministic
// inputs, runtime-resolved doc paths + cwd redacted) and compares it to a
// committed golden baseline at
//   extensions/system-prompt/upstream-prompt.golden
//
// If pi changes any fixed text (intro wording, guidelines, Pi-docs prose,
// tools-footer line, etc.) the snapshot diverges and this check fails in
// CI, printing a diff. That's the signal to:
//   1. Review the diff.
//   2. If you want to track upstream, update the constants in
//      extensions/system-prompt/system-prompt.ts (INTRO, TOOLS_FOOTER,
//      ALWAYS_ON_GUIDELINES, PI_DOCS_BLOCK) to match.
//   3. Update the golden baseline:
//        node scripts/check-upstream-prompt.mjs --update
//   4. Re-run: npm run typecheck && npm run lint && npm test
//
// If you've INTENTIONALLY diverged your constants from pi's defaults, you
// don't need to touch them — just update the golden so the drift baseline
// reflects the new upstream:
//   node scripts/check-upstream-prompt.mjs --update
//
// Implementation note: buildSystemPrompt is not exported from the package's
// public entry (only ".", "./rpc-entry", "./client"), so we import it by
// relative path from the installed dist. If pi restructures this file away,
// the script errors loudly — which is itself a drift signal to investigate.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(ROOT, "extensions/system-prompt/upstream-prompt.golden");
const TMP = join(ROOT, "extensions/system-prompt/.upstream-prompt.generated");
const UPDATE = process.argv.includes("--update");

// buildSystemPrompt lives at dist/core/system-prompt.js in the installed
// package. Resolve from node_modules at repo root.
const MOD_PATH = join(
  ROOT,
  "node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
);
let buildSystemPrompt;
try {
  ({ buildSystemPrompt } = await import(MOD_PATH));
} catch (err) {
  console.error(
    `Cannot import pi's buildSystemPrompt from ${MOD_PATH}.\n` +
      `This usually means @earendil-works/pi-coding-agent isn't installed ` +
      `or pi restructured its dist layout (itself a drift signal).\n` +
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
    "Then, if you track upstream, also update the constants in\n" +
    "  extensions/system-prompt/system-prompt.ts\n" +
    "and re-run: npm run typecheck && npm run lint && npm test\n",
);
process.exit(1);
