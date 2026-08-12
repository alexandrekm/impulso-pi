#!/usr/bin/env node
// Validates every tracked JSON config parses cleanly, and validates
// repo-root profiles.jsonc (JSONC) against the profiles schema.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, validateProfiles } from "./profiles.mjs";

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

let failed = false;

// extensions/**/*.json — plain JSON must parse.
const files = findJsonFiles("extensions");
for (const file of files) {
  try {
    JSON.parse(readFileSync(file, "utf8"));
    console.log(`ok    ${file}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${file}: ${error.message}`);
  }
}
if (files.length === 0) console.log("No JSON files found under extensions/.");

// profiles.jsonc — JSONC parse + schema validation.
const profilesPath = "profiles.jsonc";
if (!existsSync(profilesPath)) {
  failed = true;
  console.error(`FAIL  ${profilesPath}: missing`);
} else {
  try {
    const profiles = loadProfiles(profilesPath);
    const errs = validateProfiles(profiles, process.cwd());
    if (errs.length) {
      failed = true;
      console.error(`FAIL  ${profilesPath}:`);
      for (const e of errs) console.error(`  ${e}`);
    } else {
      console.log(`ok    ${profilesPath}`);
    }
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${profilesPath}: ${error.message}`);
  }
}

process.exit(failed ? 1 : 0);
