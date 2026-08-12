#!/usr/bin/env node
// Validates every tracked JSON config in extensions/ parses cleanly.
// Catches the case where a hand-edited or generated config (e.g.
// pi-footer.json) gets corrupted before it's committed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function findJsonFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.endsWith(".json")) {
      results.push(full);
    }
  }
  return results;
}

const files = findJsonFiles("extensions");

if (files.length === 0) {
  console.log("No JSON files found under extensions/.");
  process.exit(0);
}

let failed = false;
for (const file of files) {
  try {
    JSON.parse(readFileSync(file, "utf8"));
    console.log(`ok    ${file}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${file}: ${error.message}`);
  }
}

process.exit(failed ? 1 : 0);
