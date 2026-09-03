/**
 * Built-in commitlint rules — the Motive conventional-commit policy from
 * `skills/commit/SKILL.md` §0. Used as a fallback when the target repo has no
 * runnable commitlint (no `node_modules/.bin/commitlint`); when the repo's own
 * commitlint is present the factory runs that instead, so local validation
 * matches CI exactly.
 *
 * Rules encoded here:
 *   type-enum               feat fix docs style refactor perf test revert build ci
 *                           (never chore)
 *   scope-empty             scope is required
 *   valid-jira-scope        scope must match ^[A-Z][A-Z0-9]*-\d+$
 *   subject-empty           never empty
 *   subject-full-stop       subject must not end with '.'
 *   header-max-length       ≤ 200 chars
 *   body/footer-max-line    ≤ 200 chars per line
 *   no-special-chars-in-    after `type(SCOPE): ` only letters, numbers,
 *       subject             spaces and `- _ / ( ) . ,` — no colons, backticks,
 *                           brackets, or `key: value`. A trailing GitHub
 *                           cherry-pick suffix ` (#NNNN)` is stripped first.
 *   ignores                 skip when the first line, lowercased, is exactly
 *                           `initial plan`.
 */

export interface RuleViolation {
  rule: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; violations: RuleViolation[] };

const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "revert", "build", "ci"];

// `type(SCOPE): description` — scope is required by policy, but the regex
// tolerates an absent scope so we can report `scope-empty` rather than a parse
// failure. The description is `.+` on the first line only.
const HEADER_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?: (.+)$/;
const JIRA_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const CHERRYPICK_SUFFIX_RE = /\s\(#\d+\)$/;
const ALLOWED_SUBJECT_CHARS_RE = /^[A-Za-z0-9_ /().,\-]*$/;
const MAX_LINE = 200;

/** True for the Copilot/agent placeholder commit that commitlint ignores. */
export function isIgnored(message: string): boolean {
  const firstLine = (message.split(/\r?\n/)[0] ?? "").trim();
  return firstLine.toLowerCase() === "initial plan";
}

/**
 * Validate a full commit message (header + optional body) against the built-in
 * Motive rules. Returns all violations found, not just the first — the factory
 * surfaces them together so the model can fix everything in one retry.
 */
export function validateMessage(rawMessage: string): ValidationResult {
  if (isIgnored(rawMessage)) return { ok: true };

  const lines = rawMessage.split(/\r?\n/);
  const header = lines[0] ?? "";
  const violations: RuleViolation[] = [];

  if (header.length > MAX_LINE) {
    violations.push({
      rule: "header-max-length",
      message: `header is ${header.length} chars; max ${MAX_LINE}`,
    });
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length > MAX_LINE) {
      violations.push({
        rule:
          i === lines.length - 1 && lines[i].startsWith("BREAKING CHANGE")
            ? "footer-max-line-length"
            : "body-max-line-length",
        message: `line ${i + 1} is ${lines[i].length} chars; max ${MAX_LINE}`,
      });
    }
  }

  const m = header.match(HEADER_RE);
  if (!m) {
    violations.push({
      rule: "type-empty",
      message: `header must match "type(JIRA-123): description"; got: ${header || "<empty>"}`,
    });
    return { ok: false, violations };
  }
  const [, type, scope, desc] = m;

  if (!TYPES.includes(type)) {
    violations.push({
      rule: "type-enum",
      message: `type "${type}" is not in [${TYPES.join(", ")}] — "chore" is not allowed`,
    });
  }

  if (!scope) {
    violations.push({
      rule: "scope-empty",
      message: "scope is required and must be a Jira key, e.g. AICPE-107",
    });
  } else if (!JIRA_RE.test(scope)) {
    violations.push({
      rule: "valid-jira-scope",
      message: `scope "${scope}" must match ^[A-Z][A-Z0-9]*-\\d+$ (a Jira key)`,
    });
  }

  // Strip the trailing GitHub cherry-pick / squash suffix before the subject
  // checks so `feat(AICPE-1): add x (#30614)` doesn't fail on `#`.
  const subject = desc.replace(CHERRYPICK_SUFFIX_RE, "");

  if (!subject.trim()) {
    violations.push({ rule: "subject-empty", message: "subject (after the scope) is empty" });
  }
  if (subject.endsWith(".")) {
    violations.push({ rule: "subject-full-stop", message: "subject must not end with '.'" });
  }
  if (subject && !ALLOWED_SUBJECT_CHARS_RE.test(subject)) {
    const bad = [...new Set([...subject].filter((c) => !/[A-Za-z0-9_ /().,\-]/.test(c)))];
    violations.push({
      rule: "no-special-chars-in-subject",
      message: `subject contains disallowed chars: ${bad.join(" ")}; only letters, numbers, spaces and - _ / ( ) . , allowed (no colons, backticks, brackets, or "key: value")`,
    });
  }

  return violations.length ? { ok: false, violations } : { ok: true };
}

/** A one-line hint appended to block reasons so the model knows the shape. */
export const FORMAT_HINT =
  "Expected: type(JIRA-123): lowercase description — type ∈ {feat,fix,docs,style,refactor,perf,test,revert,build,ci}; scope is a Jira key; subject uses only letters/numbers/spaces and - _ / ( ) . , ; no trailing dot; ≤200 chars.";
