#!/usr/bin/env node
// Halstead difficulty gate.
//
// Halstead difficulty D = (η1 / 2) × (N2 / η2), where η1 = unique operators,
// N2 = total operands, η2 = unique operands. High D means dense, heterogeneous
// code — every line introduces new vocabulary the reader must absorb.
//
// Why vendored: no maintained ESLint rule exists for this metric
// (eslint-plugin-metrics: last published 2022; its companion halstead plugin
// never landed on npm). ts-complex (2022) works but misses arrow functions and
// methods, so it under-reports. The shared AST walk lives in lib/ts-metrics.mjs.
//
// Gate: fails (exit 1) if any function's difficulty >= --max (default 80,
// i.e. "difficulty < 80" from the quality spec).
//
// Usage:
//   node scripts/check-halstead.mjs [--max 80] [--json]

import { relative } from "node:path";
import { halsteadDifficulty, functionName, listFunctions, ROOT } from "./lib/ts-metrics.mjs";

const args = process.argv.slice(2);
const MAX = (() => {
  const i = args.indexOf("--max");
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : 80;
})();
const JSON_OUT = args.includes("--json");

const violations = [];
const all = [];

for (const { file, sourceFile, node } of listFunctions()) {
  const d = halsteadDifficulty(node);
  if (d === null) continue;
  const record = {
    file: relative(ROOT, file),
    name: functionName(node, sourceFile),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    difficulty: d,
  };
  all.push(record);
  if (d >= MAX) violations.push(record);
}

all.sort((a, b) => b.difficulty - a.difficulty);

if (JSON_OUT) {
  console.log(
    JSON.stringify({ max: MAX, total: all.length, violations, top: all.slice(0, 10) }, null, 2),
  );
} else {
  if (violations.length > 0) {
    console.error(`Halstead difficulty gate: ${violations.length} function(s) >= ${MAX}`);
    for (const v of violations) {
      console.error(`  ${v.difficulty.toFixed(1)}  ${v.file}:${v.line}  ${v.name}`);
    }
    process.exit(1);
  }
  console.log(
    `Halstead difficulty gate: OK (${all.length} functions checked, max ` +
      `${all.length ? all[0].difficulty.toFixed(1) : "0"} < ${MAX})`,
  );
}
