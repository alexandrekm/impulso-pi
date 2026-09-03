/**
 * Extract `git commit` invocations (and their messages) from a raw bash
 * command string. The factory runs this on every `bash` tool_call; if it finds
 * a commit, the message is validated before the commit is allowed to proceed.
 *
 * Reuses command-guard's shell engine (`collapseContinuations` / `normalize` /
 * `splitCommands`) to peel wrappers (`cd … &&`, `bash -c`, `timeout`, `env`,
 * `xargs`, …) and split `&&` / `;` / `|` chains — so `cd repo && git commit …`
 * is caught just like a bare `git commit`. command-guard is a core extension,
 * always present on every profile, so this cross-extension import is safe.
 *
 * Limitations (documented, low-impact): combined short flags like `-am "msg"`
 * are not fully tokenized into `-a` + `-m`; the agent almost always uses a
 * plain `git commit -m "…"`. `--no-verify`'s short form `-n` is recognized.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { collapseContinuations, normalize, splitCommands } from "../command-guard/engine.ts";

export interface CommitInfo {
  /** Message paragraphs (one per `-m`/`-F`), in order. Joined with "\n\n". */
  messages: string[];
  /** `--no-verify` / `-n` present. */
  noVerify: boolean;
  /** `--amend` present. */
  amend: boolean;
}

/**
 * Shell-ish tokenizer: splits on whitespace but keeps quoted segments (single
 * or double) intact, unquoting them. Backslash escapes are honored inside
 * double quotes (matching bash). Returns literal token values.
 */
export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    let tok = "";
    let quoted = false; // an empty quoted arg (""/ '') is a real token
    while (i < n && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        quoted = true;
        i++;
        while (i < n && s[i] !== "'") tok += s[i++];
        if (i < n) i++; // closing quote
      } else if (c === '"') {
        quoted = true;
        i++;
        while (i < n && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < n) {
            tok += s[i + 1];
            i += 2;
          } else {
            tok += s[i++];
          }
        }
        if (i < n) i++; // closing quote
      } else {
        tok += s[i++];
      }
    }
    // Preserve empty quoted tokens (e.g. `git commit -m "" file.txt`:
    // `-m` takes the empty string, `file.txt` is a pathspec). Discard only
    // bare-whitespace gaps that produced no token and no quote.
    if (tok !== "" || quoted) tokens.push(tok);
  }
  return tokens;
}

function readFileMessage(path: string): string {
  const p = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Parse a single (already-normalized) command segment for a `git commit`. */
function parseOne(part: string): CommitInfo | null {
  const toks = tokenize(part);
  if (toks.length === 0) return null;
  const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
  if (base !== "git") return null;

  // Find the `commit` subcommand token. Anything before it is git-global
  // passthrough (`-C <path>`, `-c name=val`, `--git-dir`, …) we don't need.
  let commitIdx = -1;
  for (let j = 1; j < toks.length; j++) {
    if (toks[j] === "commit") {
      commitIdx = j;
      break;
    }
  }
  if (commitIdx === -1) return null;

  const args = toks.slice(commitIdx + 1);
  const info: CommitInfo = { messages: [], noVerify: false, amend: false };
  let endOfOpts = false;

  for (let k = 0; k < args.length;) {
    const t = args[k];
    if (endOfOpts) {
      k++;
      continue;
    }
    if (t === "--") {
      endOfOpts = true;
      k++;
      continue;
    }
    if (t === "--no-verify" || t === "-n") {
      info.noVerify = true;
      k++;
      continue;
    }
    if (t === "--amend") {
      info.amend = true;
      k++;
      continue;
    }
    // -m / --message (value is the next token, or `=`-attached)
    if (t === "-m" || t === "--message") {
      if (k + 1 < args.length) info.messages.push(args[k + 1]);
      k += 2;
      continue;
    }
    if (t.startsWith("--message=")) {
      info.messages.push(t.slice("--message=".length));
      k++;
      continue;
    }
    if (t.startsWith("-m") && t.length > 2) {
      info.messages.push(t.slice(2));
      k++;
      continue;
    }
    // -F / --file (read the message from a file)
    if (t === "-F" || t === "--file") {
      if (k + 1 < args.length) info.messages.push(readFileMessage(args[k + 1]));
      k += 2;
      continue;
    }
    if (t.startsWith("--file=")) {
      info.messages.push(readFileMessage(t.slice("--file=".length)));
      k++;
      continue;
    }
    if (t.startsWith("-F") && t.length > 2) {
      info.messages.push(readFileMessage(t.slice(2)));
      k++;
      continue;
    }
    k++;
  }

  return info;
}

/**
 * Find every `git commit` in a raw bash command (across `&&`/`;`/`|` chains,
 * after peeling wrappers). Returns one CommitInfo per commit subcommand found.
 */
export function extractCommits(rawCommand: string): CommitInfo[] {
  const cmd = collapseContinuations(rawCommand);
  if (!cmd.trim()) return [];
  const norm = normalize(cmd);
  const parts = splitCommands(norm);
  const infos: CommitInfo[] = [];
  for (const part of parts) {
    const info = parseOne(normalize(part));
    if (info) infos.push(info);
  }
  return infos;
}

/** The full message git would use: paragraphs joined by a blank line. */
export function fullMessage(info: CommitInfo): string {
  return info.messages.filter((m) => m !== "").join("\n\n");
}
