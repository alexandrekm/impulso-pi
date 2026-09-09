#!/usr/bin/env node
// CRAP gate (Change Risk Analyzer and Predictor).
//
//   CRAP = comp² × (1 − coverage)³ + comp
//
// where comp is the function's cyclomatic complexity (same counting rules as
// ESLint's `complexity`, see lib/ts-metrics.mjs) and coverage is the fraction
// of the function's V8 coverage ranges executed by the test suite. The idea:
// high complexity is allowed only if you pay for it with tests — comp 4 with
// no tests scores 20 (passes), comp 10 with no tests scores 110 (fails), and
// fully covered functions score exactly comp (already gated at < 22 by ESLint).
//
// Why vendored: no maintained JS tool computes CRAP for JS/TS. This script
// runs the test suite under NODE_V8_COVERAGE, merges the per-process V8
// dumps, and joins per-function coverage with per-function complexity from
// the TypeScript AST.
//
// Caveat: V8 reports block coverage, not branch coverage — `a && b` with only
// one side exercised can still read as covered. CRAP is a risk heuristic;
// the stronger test-quality gate (mutation testing) is separate.
//
// Gate: fails (exit 1) if any function's CRAP >= --max (default 25, i.e.
// "CRAP < 25" from the quality spec). Test files (*.test.ts) and the vendored
// extensions are out of scope.
//
// Ratchet: violating functions are only allowed if listed in
// scripts/crap-exemptions.json (checked in, code-reviewable). The gate also
// FAILS on stale entries (listed but no longer violating), so the list can
// only shrink: fix a function and CI tells you to remove its entry. Adding
// entries is visible in the PR diff — the expectation is tests, not entries.
// Exemption keys are "file :: name"; anonymous functions are keyed as
// anonymous@L<line>, so refactors above them require regenerating the list
// with --update-exemptions.
//
// Usage:
//   node scripts/check-crap.mjs [--max 25] [--covdir DIR] [--json]
//     --covdir: reuse an existing NODE_V8_COVERAGE dump instead of re-running
//               the test suite.
//   node scripts/check-crap.mjs --update-exemptions
//     Regenerate scripts/crap-exemptions.json from the current violations.
//
// Usage:
//   node scripts/check-crap.mjs [--max 25] [--covdir DIR] [--json]
//     --covdir: reuse an existing NODE_V8_COVERAGE dump instead of re-running
//               the test suite.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ROOT, functionName, listFunctions, cyclomaticComplexity } from "./lib/ts-metrics.mjs";

const args = process.argv.slice(2);
const MAX = (() => {
  const i = args.indexOf("--max");
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : 25;
})();
const JSON_OUT = args.includes("--json");
const UPDATE_EXEMPTIONS = args.includes("--update-exemptions");
const EXEMPTION_FILE = join(import.meta.dirname, "crap-exemptions.json");
const COVDIR = (() => {
  const i = args.indexOf("--covdir");
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

function runTestsWithCoverage() {
  const covdir = mkdtempSync(join(tmpdir(), "v8cov-"));
  const res = spawnSync("npm", ["test"], {
    cwd: ROOT,
    env: { ...process.env, NODE_V8_COVERAGE: covdir },
    encoding: "utf8",
    // Pipe so a failing suite can be echoed (CI shows which test broke);
    // the dot reporter is small but give it headroom anyway.
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error("CRAP gate: test suite failed; cannot compute coverage.");
    console.error("── npm test output ────────────────────────────────");
    console.error(res.stdout ?? "(no stdout)");
    console.error(res.stderr ?? "");
    rmSync(covdir, { recursive: true, force: true });
    process.exit(1);
  }
  return covdir;
}

// Merge all per-process V8 dumps into:
//   Map<absolute file path, Map<fnKey, { name, spanStart, spanEnd, covered }>>
// A range counts as covered if ANY process executed it (union).
function mergeCoverage(dir) {
  const scripts = new Map();
  const addCovered = (path, fn, ranges) => {
    let fns = scripts.get(path);
    if (!fns) {
      fns = new Map();
      scripts.set(path, fns);
    }
    const root = fn.ranges[0];
    const key = `${fn.functionName} @${root.startOffset}`;
    let entry = fns.get(key);
    if (!entry) {
      entry = {
        name: fn.functionName,
        spanStart: root.startOffset,
        spanEnd: root.endOffset,
        covered: [],
      };
      fns.set(key, entry);
    }
    for (const r of ranges) entry.covered.push([r.startOffset, r.endOffset]);
  };

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const script of data.result ?? []) {
      if (!script.url?.startsWith("file://")) continue;
      const path = fileURLToPath(script.url);
      if (!path.startsWith(ROOT + "/")) continue; // only repo files
      for (const fn of script.functions ?? []) {
        const root = fn.ranges?.[0];
        if (!root) continue;
        if (!fn.isBlockCoverage) {
          if (root.count > 0) addCovered(path, fn, [root]);
        } else {
          const covered = fn.ranges.filter((r) => r.count > 0);
          if (covered.length > 0) addCovered(path, fn, covered);
        }
      }
    }
  }

  for (const fns of scripts.values()) {
    for (const e of fns.values()) {
      e.coveredBytes = unionBytes(e.covered);
      e.spanBytes = e.spanEnd - e.spanStart;
    }
  }
  return scripts;
}

function unionBytes(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curEnd = -1;
  for (const [s, e] of intervals) {
    if (e > curEnd) {
      total += e - Math.max(s, curEnd);
      curEnd = e;
    }
  }
  return total;
}

// Best-matching V8 coverage entry for one AST function. V8 start offsets sit
// at the `function` keyword, so exported functions differ from the AST node
// start by the `export ` prefix — hence the generous window plus a same-name
// preference. Falls back to the script-root entry (file-level coverage) when
// nothing matches: coarse, but never false-zero.
function matchCoverageEntry(fns, name, astStart, astEnd) {
  if (!fns) return { entry: null, fileLoaded: false };
  let best = null;
  let bestDist = Infinity;
  for (const e of fns.values()) {
    const inWindow = e.spanStart >= astStart - 20 && e.spanStart <= astEnd;
    if (!inWindow) continue;
    const sameName = e.name === name || e.name === `get ${name}` || e.name === `set ${name}`;
    const dist = Math.abs(e.spanStart - astStart) + (sameName ? 0 : 1000);
    if (dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return { entry: best ?? fns.get(" @0"), fileLoaded: true };
}

const covdir = COVDIR ?? runTestsWithCoverage();
const coverage = mergeCoverage(covdir);
if (!COVDIR) rmSync(covdir, { recursive: true, force: true });

const all = [];
const violations = [];

for (const { file, sourceFile, node } of listFunctions()) {
  if (file.endsWith(".test.ts")) continue; // test code itself is out of scope
  const name = functionName(node, sourceFile);
  const astStart = node.getStart(sourceFile);
  const astEnd = node.getEnd();
  const line = sourceFile.getLineAndCharacterOfPosition(astStart).line + 1;

  const { entry, fileLoaded } = matchCoverageEntry(coverage.get(file), name, astStart, astEnd);
  const cov = entry && entry.spanBytes > 0 ? Math.min(1, entry.coveredBytes / entry.spanBytes) : 0;
  const comp = cyclomaticComplexity(node);
  const crap = comp * comp * Math.pow(1 - cov, 3) + comp;
  const record = {
    file: relative(ROOT, file),
    name,
    line,
    comp,
    coverage: cov,
    testedFile: fileLoaded,
    crap,
  };
  all.push(record);
  if (crap >= MAX) violations.push(record);
}

all.sort((a, b) => b.crap - a.crap);

// Ratchet: violations are allowed only if listed in the exemption file;
// stale entries fail so the list only ever shrinks.
const exemptionKey = (r) => `${r.file} :: ${r.name}`;
const currentKeys = new Set(violations.map(exemptionKey));
const exemptions = existsSync(EXEMPTION_FILE)
  ? new Set(JSON.parse(readFileSync(EXEMPTION_FILE, "utf8")))
  : new Set();
const unexempt = violations.filter((v) => !exemptions.has(exemptionKey(v)));
const stale = [...exemptions].filter((k) => !currentKeys.has(k)).sort();

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        max: MAX,
        total: all.length,
        violations,
        exempted: violations.length - unexempt.length,
        staleExemptions: stale,
        top: all.slice(0, 15),
      },
      null,
      2,
    ),
  );
  process.exit(unexempt.length > 0 || stale.length > 0 ? 1 : 0);
}

const fmtCov = (r) => (r.testedFile ? `${Math.round(r.coverage * 100)}%` : "file not loaded");
const fmt = (r) =>
  `  CRAP ${r.crap.toFixed(0).padStart(4)}  comp ${r.comp}  cov ${fmtCov(r)}  ${r.file}:${r.line}  ${r.name}`;

if (UPDATE_EXEMPTIONS) {
  writeFileSync(EXEMPTION_FILE, JSON.stringify([...currentKeys].sort(), null, 2) + "\n");
  console.log(
    `CRAP exemptions: wrote ${currentKeys.size} entries to ${relative(ROOT, EXEMPTION_FILE)}`,
  );
  process.exit(0);
}

let failed = false;
if (unexempt.length > 0) {
  console.error(`CRAP gate: ${unexempt.length} unexempted function(s) >= ${MAX}`);
  for (const v of unexempt) console.error(fmt(v));
  console.error(
    "  → write tests, or run `npm run check:crap -- --update-exemptions` and review the diff",
  );
  failed = true;
}
if (stale.length > 0) {
  console.error(
    `CRAP gate: ${stale.length} stale exemption(s) — no longer violating, remove them:`,
  );
  for (const k of stale) console.error(`  ${k}`);
  console.error("  → run `npm run check:crap -- --update-exemptions` and review the diff");
  failed = true;
}
if (failed) process.exit(1);

console.log(
  `CRAP gate: OK (${all.length} functions checked, worst ` +
    `${all.length ? all[0].crap.toFixed(0) : "0"} < ${MAX}; ` +
    `${violations.length - unexempt.length} exempted, ratchet can shrink ${violations.length})`,
);
