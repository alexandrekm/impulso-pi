#!/usr/bin/env node
// check-context-record: the context-budget ratchet.
//
// The committed first-call measurement (investigation/context-measurement.json,
// written by `npm run measure:context -- --record`) is the budget record.
// A PR that changes anything that can move the first request — profiles.jsonc
// (packages/extensions/skills/settings), non-test files under extensions/,
// or skills/ — must also update the record, so the schema/instruction-char
// delta shows up in the diff next to the change that caused it.
//
// The check is deliberately "break loudly": it can't run the measurement on
// CI (the live profile dirs and the installed pi belong to your machine),
// so it enforces review visibility instead. Fix by running
// `npm run measure:context -- --record` locally and committing the record.
//
// Usage: npm run check:context-record [BASE_REF=origin/main]

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = "investigation/context-measurement.json";
const BASE_REF = process.env.BASE_REF || "origin/main";

/** Does this path plausibly move the first model request? */
function affectsFirstRequest(changed) {
  if (changed === "profiles.jsonc") return true;
  if (changed.startsWith("skills/")) return true;
  return changed.startsWith("extensions/") && !changed.endsWith(".test.ts");
}

function changedFiles() {
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", BASE_REF], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    const output = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
      cwd: REPO,
      encoding: "utf8",
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    // No git history / no base ref (local run before fetch): best-effort pass.
    console.log(
      `check-context-record: skipped (no merge-base against ${BASE_REF}: ${error.message})`,
    );
    process.exit(0);
  }
}

const changed = changedFiles();
const triggers = changed.filter(affectsFirstRequest);
if (triggers.length === 0) {
  console.log("check-context-record: nothing that moves the first request changed.");
  process.exit(0);
}

if (changed.includes(RECORD)) {
  console.log(
    `check-context-record: ${triggers.length} first-request trigger(s), record updated. OK.`,
  );
  process.exit(0);
}

console.error(`check-context-record: FAIL`);
console.error("");
console.error(`This PR changes files that move the profile's first model request:`);
for (const file of triggers) {
  console.error(`  - ${file}`);
}
console.error("");
console.error(`but does not update ${RECORD}, the committed context measurement.`);
console.error(`Run \`npm run measure:context -- --record\` locally and commit the result,`);
console.error(`so the tool-schema / instruction-char delta is visible in this diff.`);
process.exit(1);
