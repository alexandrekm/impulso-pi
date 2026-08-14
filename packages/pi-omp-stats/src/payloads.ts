/**
 * @fileoverview Payload-dump reader for the pi-omp-stats dashboard.
 *
 * The `payload-exporter` pi extension writes every provider request/response
 * as a JSON file under `<configDir>/payloads/`:
 *
 *   payloads/<YYYY-MM-DD>/<sessionId8>[-<slug>]/payload--....json
 *   payloads/<YYYY-MM-DD>/<sessionId8>[-<slug>]/errors.jsonl
 *
 * This module reads those dumps from disk so the dashboard can host a
 * "Payloads" visualizer tab (dates → sessions → request list → formatted
 * detail), replacing the old standalone `scripts/payload-browser.mjs` TUI.
 *
 * The payloads dir is the sibling of the sessions dir resolved by
 * {@link resolveSessionsDir} (i.e. `<agentDir>/payloads`), overridable via
 * `PI_STATS_PAYLOADS_DIR`. All file access is confined to that root: every
 * `rel` path is resolved and checked with `path.relative` to reject traversal
 * (`..`) or absolute paths, so a crafted `rel` can never escape the root.
 *
 * MIT, © impulso-pi authors.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSessionsDir } from "./parser.js";

/** A date bucket under the payloads root (YYYY-MM-DD). */
export interface PayloadDate {
  name: string;
  sessions: number;
}

/** A session folder under a date (name is `<sessionId8>[-<slug>]`). */
export interface PayloadSession {
  name: string;
  /** Path relative to the payloads root, e.g. `2026-08-14/ab12cd34--slug`. */
  rel: string;
  count: number;
  hasErrors: boolean;
  /** mtime in epoch ms. */
  mtime: number;
}

/** A single payload file inside a session folder. */
export interface PayloadFile {
  file: string;
  /** Path relative to the payloads root. */
  rel: string;
  size: number;
  hasResp: boolean;
  date?: string;
  time?: string;
  seq?: number;
  turn?: number;
  model?: string;
}

/** One JSONL entry from a session's errors.jsonl. */
export interface PayloadErrorEntry {
  /** Original line index in the file. */
  i: number;
  at?: string;
  source?: string;
  turnIndex?: number;
  file?: string;
  model?: { id?: string; provider?: string };
  matches?: { pattern: string; toolName?: string; toolCallId?: string; snippet: string }[];
  raw?: string;
}

/** Result of listing a session (or the flat root): files + errors. */
export interface PayloadListing {
  dir: string;
  files: PayloadFile[];
  errors: PayloadErrorEntry[];
}

const NAME_RE =
  /payload--(\d{4}-\d{2}-\d{2})--(\d{2})(\d{2})(\d{2})\.(\d{3})--seq-(\d+)--turn-(\d+)--(.+)\.json$/;

function parseName(filename: string): {
  date?: string;
  time?: string;
  seq?: number;
  turn?: number;
  model?: string;
} {
  const m = filename.match(NAME_RE);
  if (!m) return {};
  return {
    date: m[1],
    time: `${m[2]}:${m[3]}:${m[4]}.${m[5]}`,
    seq: Number(m[6]),
    turn: Number(m[7]),
    model: m[8],
  };
}

/**
 * Resolve the payloads directory.
 *
 * Precedence:
 *  1. `PI_STATS_PAYLOADS_DIR` (this package's own override)
 *  2. sibling of the sessions dir (`<dirname(sessionsDir)>/payloads`)
 *
 * A leading `~/` is expanded against `os.homedir()`.
 */
export function resolvePayloadsDir(): string {
  const expand = (p: string): string =>
    p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

  const env = process.env;
  if (env.PI_STATS_PAYLOADS_DIR && env.PI_STATS_PAYLOADS_DIR.trim()) {
    return expand(env.PI_STATS_PAYLOADS_DIR.trim());
  }
  return path.join(path.dirname(resolveSessionsDir()), "payloads");
}

/**
 * Resolve `rel` (relative to the payloads root) to an absolute path, refusing
 * anything that escapes the root. Returns `null` if the path is unsafe or
 * contains a NUL byte.
 */
function safeJoin(root: string, rel: string): string | null {
  if (!rel) return root;
  if (rel.includes("\0")) return null;
  // Reject absolute paths (POSIX or Windows) up front.
  if (path.isAbsolute(rel)) return null;
  const full = path.resolve(root, rel);
  const relFromRoot = path.relative(root, full);
  if (relFromRoot === "" || relFromRoot === ".") return full;
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) return null;
  return full;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** List date buckets (YYYY-MM-DD dirs) under the payloads root, newest first. */
export async function listPayloadDates(): Promise<{
  root: string;
  exists: boolean;
  dates: PayloadDate[];
  flat: number;
}> {
  const root = resolvePayloadsDir();
  if (!(await exists(root))) {
    return { root, exists: false, dates: [], flat: 0 };
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dates: PayloadDate[] = [];
  let flat = 0;
  for (const e of entries) {
    if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)) {
      try {
        const subs = await fs.readdir(path.join(root, e.name), { withFileTypes: true });
        const n = subs.filter((s) => s.isDirectory()).length;
        dates.push({ name: e.name, sessions: n });
      } catch {
        dates.push({ name: e.name, sessions: 0 });
      }
    } else if (e.isFile() && e.name.startsWith("payload--") && e.name.endsWith(".json")) {
      flat++;
    }
  }
  dates.sort((a, b) => b.name.localeCompare(a.name));
  return { root, exists: true, dates, flat };
}

/** List session folders under a date dir, newest-first by mtime. */
export async function listPayloadSessions(date: string): Promise<{
  date: string;
  sessions: PayloadSession[];
}> {
  const root = resolvePayloadsDir();
  const datePath = safeJoin(root, date);
  if (!datePath || !(await exists(datePath))) return { date, sessions: [] };
  const st = await fs.stat(datePath);
  if (!st.isDirectory()) return { date, sessions: [] };
  const entries = await fs.readdir(datePath, { withFileTypes: true });
  const sessions: PayloadSession[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sessionPath = path.join(datePath, e.name);
    let count = 0;
    let hasErrors = false;
    try {
      for (const f of await fs.readdir(sessionPath)) {
        if (f.startsWith("payload--") && f.endsWith(".json")) count++;
        if (f === "errors.jsonl") hasErrors = true;
      }
    } catch {
      // unreadable session dir — skip its contents
    }
    let mtime = 0;
    try {
      mtime = (await fs.stat(sessionPath)).mtimeMs;
    } catch {
      // leave 0
    }
    sessions.push({
      name: e.name,
      rel: path.posix.join(date, e.name),
      count,
      hasErrors,
      mtime,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { date, sessions };
}

/**
 * List payload files + errors.jsonl entries for a session (or the flat root
 * when `dir` is empty). `dir` is relative to the payloads root.
 */
export async function listPayloadFiles(dir: string): Promise<PayloadListing> {
  const root = resolvePayloadsDir();
  const abs = dir ? safeJoin(root, dir) : root;
  if (!abs) return { dir, files: [], errors: [] };
  if (!(await exists(abs))) return { dir, files: [], errors: [] };
  const st = await fs.stat(abs);
  if (!st.isDirectory()) return { dir, files: [], errors: [] };

  const entries = await fs.readdir(abs);
  const files: PayloadFile[] = [];
  for (const f of entries) {
    if (!f.startsWith("payload--") || !f.endsWith(".json")) continue;
    const full = path.join(abs, f);
    let size = 0;
    let hasResp = false;
    try {
      size = (await fs.stat(full)).size;
      const data = JSON.parse(await fs.readFile(full, "utf8"));
      hasResp = !!data?.response;
    } catch {
      // unreadable / unparseable — still list it, just without resp flag
    }
    files.push({
      file: f,
      rel: dir ? path.posix.join(dir, f) : f,
      size,
      hasResp,
      ...parseName(f),
    });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const errors = await readPayloadErrors(dir);
  return { dir, files, errors };
}

/** Read and parse a session's errors.jsonl (empty if absent/unreadable). */
export async function readPayloadErrors(dir: string): Promise<PayloadErrorEntry[]> {
  const root = resolvePayloadsDir();
  const absDir = dir ? safeJoin(root, dir) : root;
  if (!absDir) return [];
  const errPath = path.join(absDir, "errors.jsonl");
  if (!(await exists(errPath))) return [];
  let raw: string;
  try {
    raw = await fs.readFile(errPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return { i, ...(JSON.parse(line) as Omit<PayloadErrorEntry, "i">) };
      } catch {
        return { i, raw: line };
      }
    });
}

/** Read and parse a single payload file by its root-relative path. */
export async function readPayloadFile(rel: string): Promise<{ data: unknown } | null> {
  const root = resolvePayloadsDir();
  const abs = safeJoin(root, rel);
  if (!abs || !(await exists(abs))) return null;
  const st = await fs.stat(abs);
  if (!st.isFile()) return null;
  try {
    const data = JSON.parse(await fs.readFile(abs, "utf8"));
    return { data };
  } catch (e) {
    return { data: { __error: e instanceof Error ? e.message : String(e) } };
  }
}

/** Whether the payloads root exists (used to hide the tab when absent). */
export async function payloadsExist(): Promise<boolean> {
  return exists(resolvePayloadsDir());
}

// Re-export sync variant of exists for callers that need it.
export const _existsSync = fsSync.existsSync;
