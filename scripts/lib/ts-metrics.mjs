// Shared TypeScript-AST metric helpers for the vendored quality gates
// (check-halstead.mjs, check-crap.mjs). Everything here walks the AST the
// same way: every function-like node is scored on its own body, with nested
// function-like nodes excluded (they are scored as their own entries).
//
// Kept in sync with eslint.config.js ignores and tsconfig exclude: the
// vendored extensions are upstream-managed re-sync targets, not our code.

import ts from "typescript";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXCLUDED_DIRS = new Set(["orca-integration", "herdr", "pi-dynamic-footer"]);

export const ROOT = join(import.meta.dirname, "..", "..");
const TARGET = join(ROOT, "extensions");

export function walkTsFiles(dir = TARGET) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

export function isFunctionLike(node) {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

// Human-readable name for a function node; falls back to source position.
export function functionName(node, sourceFile) {
  if (node.name) {
    if (ts.isComputedPropertyName(node.name)) return "<computed>";
    if (node.name.text) return node.name.text;
  }
  // Arrow/function-expression assigned to a variable or property: use that.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
      const key = parent.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text;
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      break;
    }
  }
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `anonymous@L${line + 1}`;
}

// Walk `fn`'s own body, skipping nested function-like nodes.
export function walkOwnNodes(fn, visit) {
  const rec = (node) => {
    if (node !== fn && isFunctionLike(node)) return; // nested: scored separately
    visit(node);
    ts.forEachChild(node, rec);
  };
  ts.forEachChild(fn, rec);
}

// ── Halstead ──────────────────────────────────────────────────────────────
// Classification follows classic tooling (same scheme as ts-complex):
//   operands  = identifiers + literals
//   operators = punctuation + keywords
// Type annotations count too — in TS they are part of the reading burden.

function isOperand(node) {
  return (
    ts.isIdentifier(node) ||
    (node.kind >= ts.SyntaxKind.FirstLiteralToken && node.kind <= ts.SyntaxKind.LastLiteralToken)
  );
}

function isOperator(node) {
  return (
    (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation) ||
    (node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword)
  );
}

export function halsteadDifficulty(fn) {
  const acc = { operatorTotal: 0, operandTotal: 0, operators: new Set(), operands: new Set() };
  walkOwnNodes(fn, (node) => {
    if (isOperand(node)) {
      acc.operandTotal++;
      acc.operands.add(node.text);
    } else if (isOperator(node)) {
      acc.operatorTotal++;
      acc.operators.add(ts.tokenToString(node.kind) ?? String(node.kind));
    }
  });
  const uniqueOperators = acc.operators.size;
  const uniqueOperands = acc.operands.size;
  if (acc.operatorTotal + acc.operandTotal === 0 || uniqueOperands === 0) return null;
  return (uniqueOperators / 2) * (acc.operandTotal / uniqueOperands);
}

// ── Cyclomatic ────────────────────────────────────────────────────────────
// Counts decision points (base 1): if, loops, case clauses, catch, ternaries,
// &&/||/??, optional chaining — mirroring ESLint's `complexity` rule so the
// CRAP formula's "comp" input matches the number ESLint already enforces.

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.QuestionDotToken,
]);

export function cyclomaticComplexity(fn) {
  let comp = 1;
  walkOwnNodes(fn, (node) => {
    if (DECISION_KINDS.has(node.kind)) comp++;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      comp++;
    }
  });
  return comp;
}

// ── Function enumeration ─────────────────────────────────────────────────
// Parses every non-vendored .ts file and returns one record per
// function-like node with body.

export function listFunctions() {
  const out = [];
  for (const file of walkTsFiles()) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
    );
    const visit = (node) => {
      if (isFunctionLike(node) && node.body) {
        out.push({ file, sourceFile, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return out;
}
