/**
 * Command-guard decision engine.
 *
 * Port of the Go PreToolUse hook in KeepTruckin/motive-agent-skills#207,
 * adapted for pi: default-allow, peel wrappers instead of fail-closed
 * flooring them, then glob-match ask/deny patterns against each subcommand.
 */

export type Decision = "allow" | "ask" | "deny";

export interface GuardConfig {
  allow?: string[];
  ask: string[];
  deny: string[];
}

export interface DecisionResult {
  decision: Decision;
  command: string;
  pattern?: string;
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

const CD_RE = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const SHELL_RE = /^(?:sh|bash|dash|zsh|ksh)\s+-c\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/;
const EVAL_RE = /^eval\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/;
const TIMEOUT_RE = /^timeout(?:\s+--\S+)*\s+\S+\s+/;
const NICE_RE = /^nice(?:\s+-n\s+\S+)?\s+/;
const SIMPLE_PREFIX_RE = /^(?:nohup|time|stdbuf|setsid|ionice|flock)\s+/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const FLAGS_TAKING_VALUE = new Set([
  "-C",
  "-c",
  "-D",
  "-e",
  "-E",
  "-f",
  "-F",
  "-i",
  "-I",
  "-l",
  "-L",
  "-m",
  "-n",
  "-o",
  "-O",
  "-p",
  "-q",
  "-r",
  "-s",
  "-S",
  "-t",
  "-T",
  "-u",
  "-U",
  "-w",
  "-x",
]);

export function collapseContinuations(cmd: string): string {
  return cmd.replace(/\\\n\s*/g, " ");
}

function peelEnv(s: string): string | undefined {
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "env") return undefined;
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "-i" || tok === "-0" || tok === "-v") {
      i++;
      continue;
    }
    if (tok === "-u" || tok === "-C" || tok === "-S") {
      i += 2;
      continue;
    }
    if (ENV_ASSIGN_RE.test(tok)) {
      i++;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return undefined;
  return tokens.slice(i).join(" ");
}

function peelXargs(s: string): string | undefined {
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "xargs") return undefined;
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.startsWith("-")) break;
    if (tok.startsWith("--") && tok.includes("=")) {
      i++;
      continue;
    }
    if (!tok.startsWith("--no-") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      i += 2;
      continue;
    }
    i++;
  }
  if (i >= tokens.length) return undefined;
  return tokens.slice(i).join(" ");
}

function stripOnce(cmd: string): { next: string; changed: boolean } {
  const s = cmd.trim();

  const cd = s.match(CD_RE);
  if (cd) return { next: s.slice(cd[0].length).trim(), changed: true };

  const shell = s.match(SHELL_RE);
  if (shell) return { next: (shell[1] || shell[2] || "").trim(), changed: true };

  const ev = s.match(EVAL_RE);
  if (ev) return { next: (ev[1] || ev[2] || "").trim(), changed: true };

  const timeout = s.match(TIMEOUT_RE);
  if (timeout) return { next: s.slice(timeout[0].length).trim(), changed: true };

  const nice = s.match(NICE_RE);
  if (nice && nice[0].length < s.length) {
    return { next: s.slice(nice[0].length).trim(), changed: true };
  }

  const prefix = s.match(SIMPLE_PREFIX_RE);
  if (prefix) return { next: s.slice(prefix[0].length).trim(), changed: true };

  const env = peelEnv(s);
  if (env !== undefined) return { next: env, changed: true };

  const xargs = peelXargs(s);
  if (xargs !== undefined) return { next: xargs, changed: true };

  return { next: s, changed: false };
}

export function normalize(cmd: string): string {
  let current = cmd.trim();
  for (let i = 0; i < 20; i++) {
    const { next, changed } = stripOnce(current);
    if (!changed) break;
    current = next;
  }
  return current;
}

export function splitCommands(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let subDepth = 0;
  const runes = [...cmd];

  for (let i = 0; i < runes.length; i++) {
    const c = runes[i];

    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
      continue;
    }
    if (inSingle) {
      current += c;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      current += c;
      continue;
    }
    if (c === "\\" && inDouble) {
      current += c;
      i++;
      if (i < runes.length) current += runes[i];
      continue;
    }
    if (c === "$" && i + 1 < runes.length && runes[i + 1] === "(") {
      subDepth++;
      current += c;
      i++;
      current += runes[i];
      continue;
    }
    if (c === ")" && subDepth > 0) {
      subDepth--;
      current += c;
      continue;
    }

    if (!inDouble && subDepth === 0) {
      const next = i + 1 < runes.length ? runes[i + 1] : "";
      if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
        const s = current.trim();
        if (s) parts.push(s);
        current = "";
        i++;
        continue;
      }
      if (c === "|" && next !== "&") {
        const s = current.trim();
        if (s) parts.push(s);
        current = "";
        continue;
      }
      if (c === ";") {
        const s = current.trim();
        if (s) parts.push(s);
        current = "";
        continue;
      }
    }

    current += c;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [cmd.trim()];
}

export function flagStripped(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i === 0) {
      out.push(tok);
      continue;
    }
    if (tok.startsWith("--")) {
      if (tok.includes("=")) continue;
      if (!tok.startsWith("--no-") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++;
      }
      continue;
    }
    if (tok.length >= 2 && tok[0] === "-" && /[A-Za-z]/.test(tok[1])) {
      if (FLAGS_TAKING_VALUE.has(tok)) i++;
      continue;
    }
    out.push(tok);
  }

  return out.join(" ");
}

function patternToRegex(pattern: string): RegExp {
  const p = pattern.trim();
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  const suffix = p.endsWith("*") ? "" : "$";
  return new RegExp(`^${escaped}${suffix}`, "i");
}

export function matchesPattern(pattern: string, normalizedCmd: string, skeleton: string): boolean {
  const re = patternToRegex(pattern);
  return re.test(normalizedCmd) || re.test(skeleton);
}

export function decide(normalizedCmd: string, cfg: GuardConfig): DecisionResult {
  const skeleton = flagStripped(normalizedCmd);

  for (const pattern of cfg.deny) {
    if (matchesPattern(pattern, normalizedCmd, skeleton)) {
      return { decision: "deny", command: normalizedCmd, pattern };
    }
  }
  for (const pattern of cfg.allow ?? []) {
    if (matchesPattern(pattern, normalizedCmd, skeleton)) {
      return { decision: "allow", command: normalizedCmd, pattern };
    }
  }
  for (const pattern of cfg.ask) {
    if (matchesPattern(pattern, normalizedCmd, skeleton)) {
      return { decision: "ask", command: normalizedCmd, pattern };
    }
  }
  return { decision: "allow", command: normalizedCmd };
}

export function decideProgram(rawCommand: string, cfg: GuardConfig): DecisionResult {
  const command = collapseContinuations(rawCommand);
  if (!command.trim()) {
    return { decision: "allow", command };
  }

  const normalized = normalize(command);
  const parts = splitCommands(normalized);
  let inner: DecisionResult = { decision: "allow", command: normalized };

  const targets = parts.length === 1 ? [normalized] : parts;
  for (const part of targets) {
    const partNorm = normalize(part);
    const result = decide(partNorm, cfg);
    if (RANK[result.decision] > RANK[inner.decision]) inner = result;
    if (inner.decision === "deny") break;
  }
  return inner;
}
